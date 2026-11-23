import { initSettings } from './settings.js';
import { initClocks } from './clocks.js';
import { initSky, rerender as rerenderSky } from './sky.js';
import { initSats, rerender as rerenderSats } from './sats.js';
import { initWeather, rerender as rerenderWeather } from './weather.js';
import { initLinks } from './links.js';
import { initCalc } from './calc.js';
import { initPrecip, initPrecipSettings, rerender as rerenderPrecip } from './precip.js';

const $ = (id) => document.getElementById(id);
const safe = (id, fn) => {
  try { fn(); } catch (err) {
    console.error(err);
    $(id)?.insertAdjacentHTML('beforeend', `<p class="error">Failed to load: ${err.message}</p>`);
  }
};

// Chart colours are read from CSS variables at creation; rebuild on theme change.
const rerenderCharts = () => { rerenderSky(); rerenderSats(); rerenderWeather($('weather')); rerenderPrecip(); };

safe('settings', () => initSettings(rerenderCharts));
safe('clocks', () => initClocks($('clocks'), $('world')));
safe('sky', () => initSky($('sky')));
safe('sats', () => initSats($('sats')));
safe('weather', () => initWeather($('weather')));
safe('precip', () => { initPrecip($('precip')); initPrecipSettings($('settings')); });
safe('calc', () => initCalc($('calc')));
safe('links', () => initLinks($('links')));

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rerenderCharts);
