import { withBasePath } from '../utils/assetPaths';

export function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    const serviceWorkerPath = withBasePath('service-worker.js');
    navigator.serviceWorker.register(serviceWorkerPath).catch(() => {
      // ignore
    });
  }
}
