import { createApp } from 'vue'
import App from './App.vue'
import '../../shared/ui/tokens.css'
import './style.css'
createApp(App).mount('#app')
if (import.meta.env.PROD && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(error => console.error('Offline setup failed', error))
