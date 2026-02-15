import express from 'express';
import 'dotenv/config';
import { ENV } from './config/env.js';
import job from './config/cron.js';
import demographicsRoutes from './routes/demographics.js';
import mealRoutes from './routes/meals.js';
import favoritesRoutes from './routes/favorites.js';
import shoppingRoutes from './routes/shopping.js';
import calorieRoutes from './routes/calorie.js';

// Import the new routers we will create
import userRoutes from './routes/users.js';

const app = express();
const PORT = ENV.PORT || 3000;

if (ENV.NODE_ENV === "production") {job.start();}

app.use(express.json());

app.get("/api/health", (req, res) => {
  res.status(200).json({success: true});
});

app.use('/api/users', userRoutes);
app.use('/api/demographics', demographicsRoutes)
app.use('/api/meals', mealRoutes);
app.use('/api/favorites', favoritesRoutes);
app.use('/api/shopping', shoppingRoutes);
app.use('/api/calorie', calorieRoutes);

app.listen(PORT, () => {
  console.log('Server is running on port:', PORT);
});