import { mountWeatherDashboard } from "./index.js";

const root = document.querySelector<HTMLElement>("#weather-app");

// mount only when the application shell is present
if (root !== null) {
  mountWeatherDashboard(root);
}
