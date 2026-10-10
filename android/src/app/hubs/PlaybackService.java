package app.hubs;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Tient l'application en vie pendant qu'une salle est ouverte : sans ce service de premier plan,
 * Android endort le processeur et le Wi-Fi peu après l'extinction de l'écran, et le son se coupe.
 * La page elle-même vit dans MainActivity ; ici, seulement de quoi rester éveillé.
 */
public class PlaybackService extends Service {
    private static final String CHANNEL = "lecture";
    private PowerManager.WakeLock cpu;
    private WifiManager.WifiLock wifi;

    @Override
    @SuppressWarnings("deprecation") // WIFI_MODE_FULL_HIGH_PERF : le seul mode qui tienne écran éteint, jusqu'à Android 13
    public void onCreate() {
        super.onCreate();
        getSystemService(NotificationManager.class).createNotificationChannel(
                new NotificationChannel(CHANNEL, getString(R.string.channel), NotificationManager.IMPORTANCE_LOW));
        Intent app = new Intent(this, MainActivity.class);
        PendingIntent open = PendingIntent.getActivity(this, 0, app, PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getActivity(this, 1, new Intent(app).setAction(MainActivity.STOP), PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(getString(R.string.app_name))
                .setContentText(getString(R.string.notification_text))
                .setContentIntent(open)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(null, getString(R.string.stop), stop).build())
                .build();
        startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);

        cpu = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "hubs:lecture");
        cpu.acquire();
        // Sans cela le Wi-Fi passe en économie d'énergie et livre le son par paquets tardifs.
        wifi = getApplicationContext().getSystemService(WifiManager.class).createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "hubs:lecture");
        wifi.acquire();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_NOT_STICKY; // relancé sans la page, le service ne servirait à rien
    }

    // Application balayée de la liste des tâches : la page disparaît, le service aussi.
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
    }

    @Override
    public void onDestroy() {
        if (cpu.isHeld()) cpu.release();
        if (wifi.isHeld()) wifi.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
