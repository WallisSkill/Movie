const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('api', {
  list: call('catalog:list'),
  genre: call('catalog:genre'),
  country: call('catalog:country'),
  search: call('catalog:search'),
  genres: call('catalog:genres'),
  countries: call('catalog:countries'),
  detail: call('catalog:detail'),
  cast: call('catalog:cast'),
  format: call('catalog:format'),
  hh3d: call('catalog:hh3d'),
  hh3dSearch: call('catalog:hh3dSearch'),
  hh3dDetail: call('catalog:hh3dDetail'),
  hh3dUpdated: call('catalog:hh3dUpdated'),
  build: call('app:build'),
  trailerBase: call('app:trailerBase'),
  readStore: call('store:read'),
  writeStore: call('store:write'),
});
