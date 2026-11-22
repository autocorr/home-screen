import { initSettings } from './settings.js';
import { initClocks } from './clocks.js';
import { initSky, rerender as rerenderSky } from './sky.js';
import { initWeather, rerender as rerenderWeather } from './weather.js';
import { initLinks } from './links.js';
import { initPrecip, initPrecipSettings, rerender as rerenderPrecip } from './precip.js';

const $ = (id) => document.getElementById(id);
const safe = (id, fn) => {
  try { fn(); } catch (err) {
    console.error(err);
    $(id)?.insertAdjacentHTML('beforeend', `<p class="error">Failed to load: ${err.message}</p>`);
  }
};

// Chart colours are read from CSS variables at creation; rebuild on theme change.
const rerenderCharts = () => { rerenderSky(); rerenderWeather($('weather')); rerenderPrecip(); };

safe('settings', () => initSettings(rerenderCharts));
safe('clocks', () => initClocks($('clocks'), $('world')));
safe('sky', () => initSky($('sky')));
safe('weather', () => initWeather($('weather')));
safe('precip', () => { initPrecip($('precip')); initPrecipSettings($('settings')); });
safe('links', () => initLinks($('links')));

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rerenderCharts);
