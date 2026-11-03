/**
 * Pharmacie Bleue Plus — Android Native Bridge (Capacitor 6)
 * ==========================================================
 * Connects web clinical PWA with native Android subsystems:
 * - Exact AlarmManager (@capacitor/local-notifications) for Doze-mode intake reminders
 * - In-App Camera Viewfinder & Scoped Storage Gallery (@capacitor/camera)
 * - Android Network Monitor (@capacitor/network) & Native Status Bar (@capacitor/status-bar)
 */

(function (window) {
  'use strict';

  const isNative = Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  console.log(`[PBP NATIVE BRIDGE] Runtime environment: ${isNative ? 'ANDROID_NATIVE_CONTAINER' : 'STANDALONE_WEB_SHELL'}`);

  const AndroidBridge = {
    isNative,

    // Initialize native UI & channels
    async init() {
      if (!isNative) return;

      document.body.classList.add('pbp-android-native');
      const dlBtn = document.getElementById('androidDownloadPill');
      if (dlBtn) dlBtn.style.display = 'none';

      try {
        const { StatusBar, Style } = window.Capacitor.Plugins.StatusBar || {};
        if (StatusBar) {
          await StatusBar.setStyle({ style: Style.Light });
          await StatusBar.setBackgroundColor({ color: '#FFFFFF' });
        }
      } catch (e) {
        console.warn('[NATIVE STATUSBAR] Could not initialize:', e);
      }

      try {
        const { LocalNotifications } = window.Capacitor.Plugins;
        if (LocalNotifications) {
          // Request notification permissions (Android 13+)
          const perm = await LocalNotifications.requestPermissions();
          console.log('[NATIVE ALARM] Permission status:', perm);

          // Create dedicated high-priority Clinical Intake Channel
          await LocalNotifications.createChannel({
            id: 'pbp_med_intake',
            name: 'Pharmacie Bleue Plus — Rappels de Prise',
            description: 'Canal prioritaire d observance therapeutique avec alarme sonore',
            importance: 5, // High / Heads-up notification
            visibility: 1, // Public on lockscreen
            sound: 'pbp_alarm_chime.wav',
            vibration: true,
            lights: true,
            lightColor: '#0284C7'
          });
        }
      } catch (e) {
        console.warn('[NATIVE ALARM CHANNEL] Could not register:', e);
      }

      try {
        const { SplashScreen } = window.Capacitor.Plugins;
        if (SplashScreen) {
          await SplashScreen.hide();
        }
      } catch (_) {}
    },

    // Native Camera Viewfinder / Gallery Picker with auto-compression
    async capturePrescriptionPhoto() {
      if (!isNative || !window.Capacitor.Plugins.Camera) {
        // Fallback for web preview: trigger standard file input
        const fileInp = document.getElementById('rxFileInput');
        if (fileInp) fileInp.click();
        return null;
      }

      try {
        const { Camera, CameraResultType, CameraSource } = window.Capacitor.Plugins;
        const photo = await Camera.getPhoto({
          quality: 85,
          allowEditing: true,
          resultType: CameraResultType.DataUrl,
          source: CameraSource.Prompt, // Allows choosing between Camera and Photos
          promptLabelHeader: 'Ordonnance Médicale',
          promptLabelPhoto: 'Choisir dans la Galerie',
          promptLabelPicture: 'Prendre une Photo (Caméra)',
          promptLabelCancel: 'Annuler',
          width: 1600,
          height: 1200,
          correctOrientation: true
        });

        if (photo && photo.dataUrl) {
          return photo.dataUrl;
        }
      } catch (e) {
        if (String(e.message || e).includes('User cancelled')) {
          console.log('[CAMERA] User cancelled photo capture.');
          return null;
        }
        console.error('[CAMERA ERROR]', e);
        throw e;
      }
      return null;
    },

    // Schedule exact medication alarm with Android AlarmManager
    async scheduleNativeMedAlarm({ id, title, body, hour, minute }) {
      if (!isNative || !window.Capacitor.Plugins.LocalNotifications) {
        return false;
      }

      try {
        const { LocalNotifications } = window.Capacitor.Plugins;
        const notificationId = Math.abs(Number(String(id).replace(/\D/g, '').slice(-8))) || Math.floor(Math.random() * 900000);

        // Compute next target timestamp
        const now = new Date();
        const target = new Date();
        target.setHours(hour, minute, 0, 0);
        if (target <= now) {
          target.setDate(target.getDate() + 1); // schedule for tomorrow if already passed today
        }

        await LocalNotifications.schedule({
          notifications: [
            {
              id: notificationId,
              title: title || 'Rappel Médicament — Pharmacie Bleue Plus',
              body: body || 'Il est l heure de prendre votre traitement.',
              channelId: 'pbp_med_intake',
              schedule: {
                at: target,
                allowWhileIdle: true,
                repeats: true,
                every: 'day'
              },
              sound: 'pbp_alarm_chime.wav',
              actionTypeId: 'MED_INTAKE_ACTION',
              extra: {
                medId: id,
                scheduledTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
              }
            }
          ]
        });

        console.log(`[NATIVE ALARM] Scheduled alarm ${notificationId} for ${target.toLocaleString()}`);
        return true;
      } catch (e) {
        console.warn('[NATIVE ALARM FAIL] Could not schedule via Android AlarmManager:', e);
        return false;
      }
    },

    // Cancel native alarm
    async cancelNativeAlarm(notificationId) {
      if (!isNative || !window.Capacitor.Plugins.LocalNotifications) return;
      try {
        const { LocalNotifications } = window.Capacitor.Plugins;
        await LocalNotifications.cancel({
          notifications: [{ id: notificationId }]
        });
      } catch (_) {}
    }
  };

  window.PBP_AndroidBridge = AndroidBridge;

  // Auto-init on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => AndroidBridge.init());
  } else {
    AndroidBridge.init();
  }

})(window);
