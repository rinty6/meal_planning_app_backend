// This file will help keep our Api available by pinging it at regular intervals every 14 mins
// This helps for the development process as some free hosting services put the app to sleep after a period of inactivity
// Consider to use another paid plan for production deployment to avoid this issue

import cron from "cron";
import https from "https";

const job = new cron.CronJob("*/14 * * * *", function () {
  https
    .get(process.env.RENDER_URL, (res) => {
      if (res.statusCode === 200) console.log("GET request sent successfully");
      else console.log("GET request failed", res.statusCode);
    })
    .on("error", (e) => console.error("Error while sending request", e));
});

export default job;