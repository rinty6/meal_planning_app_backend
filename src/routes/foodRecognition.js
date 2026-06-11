import { Blob } from 'node:buffer';
import express from 'express';
import { ENV } from '../config/env.js';
import { requireClerkAuth, attachUserFromAuth } from '../middleware/auth.js';

const foodRecognitionRoutes = express.Router();

// 8,000,000 base64 chars decode to exactly 6 MB, matching the FastAPI
// feedback image cap (FEEDBACK_MAX_FILE_SIZE_MB = 6) so oversized images are
// rejected here with a clear 413 instead of an upstream error.
const MAX_IMAGE_BASE64_CHARS = 8_000_000;
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const normalizeBaseUrl = (value) => String(value || '').trim().replace(/\/+$/, '');

const parseBase64Image = (value, fallbackMimeType = 'image/jpeg') => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.length > MAX_IMAGE_BASE64_CHARS) {
    const error = new Error('Image is too large.');
    error.status = 413;
    throw error;
  }

  const match = raw.match(/^data:([^;,]+);base64,([\s\S]+)$/);
  const mimeType = (match?.[1] || fallbackMimeType).toLowerCase();
  const base64 = (match?.[2] || raw).replace(/\s+/g, '');
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    const error = new Error('Unsupported image type. Use JPEG, PNG, or WebP.');
    error.status = 415;
    throw error;
  }

  // Buffer.from never throws on malformed base64 (it silently skips invalid
  // characters), so validate explicitly to return a real 400.
  if (!BASE64_RE.test(base64)) {
    const error = new Error('Invalid base64 image.');
    error.status = 400;
    throw error;
  }

  return {
    mimeType,
    buffer: Buffer.from(base64, 'base64'),
  };
};

const requireFoodRecognitionConfig = () => {
  const baseUrl = normalizeBaseUrl(ENV.FOOD_RECOGNITION_API_URL);
  const token = String(ENV.FOOD_RECOGNITION_API_TOKEN || '').trim();

  if (!baseUrl || !token) {
    const error = new Error('Food recognition service is not configured.');
    error.status = 503;
    throw error;
  }

  return { baseUrl, token };
};

const sendUpstreamResponse = async (res, upstreamResponse) => {
  if (upstreamResponse.status === 204) {
    return res.status(204).end();
  }

  const contentType = upstreamResponse.headers.get('content-type') || '';
  const text = await upstreamResponse.text();
  if (contentType.includes('application/json')) {
    res.set('content-type', 'application/json');
    return res.status(upstreamResponse.status).send(text || '{}');
  }

  return res.status(upstreamResponse.status).json({
    error: text || 'Food recognition service request failed.',
  });
};

const callFoodRecognition = async (path, formData, clientKey) => {
  const { baseUrl, token } = requireFoodRecognitionConfig();
  const headers = {
    'x-food-api-token': token,
  };
  // Per-user rate-limit key for the FastAPI service. Without it, all app
  // users would share one bucket because every proxied request arrives from
  // this backend's single IP.
  if (clientKey) {
    headers['x-food-client-key'] = String(clientKey);
  }
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: formData,
  });
};

foodRecognitionRoutes.post('/predict', requireClerkAuth, attachUserFromAuth, async (req, res) => {
  try {
    const parsedImage = parseBase64Image(req.body?.imageBase64, req.body?.mimeType);
    if (!parsedImage?.buffer?.length) {
      return res.status(400).json({ error: 'imageBase64 is required.' });
    }

    const formData = new FormData();
    formData.append(
      'file',
      new Blob([parsedImage.buffer], { type: parsedImage.mimeType }),
      'food.jpg',
    );

    const upstreamResponse = await callFoodRecognition('/predict', formData, req.auth?.clerkId);
    return sendUpstreamResponse(res, upstreamResponse);
  } catch (error) {
    console.error('Food recognition predict proxy error:', error);
    return res.status(error.status || 502).json({
      error: error.message || 'Food recognition request failed.',
    });
  }
});

foodRecognitionRoutes.post('/feedback', requireClerkAuth, attachUserFromAuth, async (req, res) => {
  try {
    const predictedClass = String(req.body?.predictedClass || '').trim();
    const correctClass = String(req.body?.correctClass || '').trim();
    if (!predictedClass || !correctClass) {
      return res.status(400).json({ error: 'predictedClass and correctClass are required.' });
    }

    const formData = new FormData();
    formData.append('predicted_class', predictedClass);
    formData.append('correct_class', correctClass);

    if (req.body?.imageBase64) {
      const parsedImage = parseBase64Image(req.body.imageBase64, req.body?.mimeType);
      formData.append(
        'file',
        new Blob([parsedImage.buffer], { type: parsedImage.mimeType }),
        'feedback.jpg',
      );
    }

    const upstreamResponse = await callFoodRecognition('/feedback', formData, req.auth?.clerkId);
    return sendUpstreamResponse(res, upstreamResponse);
  } catch (error) {
    console.error('Food recognition feedback proxy error:', error);
    return res.status(error.status || 502).json({
      error: error.message || 'Food recognition feedback failed.',
    });
  }
});

export default foodRecognitionRoutes;
