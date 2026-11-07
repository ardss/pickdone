# PickDone Mobile MVP

Vue 3 + Vite + Capacitor 8. Android uses a separate native SQLite database named `pickdone_mobile`. Browser preview uses a separate IndexedDB database named `pickdone-mobile-v1`. Neither store reads desktop user data. There is no sync endpoint.

## Run and verify

- `npm ci`
- `npm test` checks project, task, completion and episode persistence after reopening the repository.
- `npm run build`
- `npx vite preview --host 127.0.0.1`
- `npm run test:ui` runs a real Chromium journey against the preview URL. Set `MOBILE_URL` if the preview port differs from 4173 and `CHROME_PATH` if Chrome or Edge is not in a standard Windows installation directory.
- `npm run android:sync`
- `cd android && gradlew.bat assembleDebug` requires Android SDK platform 36, build tools, Gradle Wrapper download or cache, and JDK 21.

Android app data is local to the app. Android cloud backup is disabled. Device restart persistence needs verification on a connected Android device before runtime acceptance.