import { createApp } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';
import App from './App.vue';
import { chunkLoadRecovery } from '../../src/utils/chunkLoadRecovery';
import './style.css';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/source' },
    { path: '/before', component: () => import('./pages/BeforePage.vue') },
    { path: '/broken', component: () => import('./pages/BrokenPage.vue') },
    { path: '/source', component: () => import('./pages/SourcePage.vue') },
    { path: '/target', component: () => import('./pages/TargetPage.vue') },
  ],
});

const app = createApp(App);
chunkLoadRecovery.install(router, {
  onUnexpectedNavigationError(error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    sessionStorage.setItem('e2e:unexpected-navigation-error', message);
    console.error(error);
  },
});
app.use(router).mount('#app');
