package app.hubs;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.security.MessageDigest;

/**
 * Affiche la page d'une salle (celle que sert le serveur, inchangée) et la garde active écran
 * éteint. Deux écrans : l'adresse du serveur, puis la page. Le son vient de la page ; PlaybackService
 * empêche seulement le téléphone de s'endormir tant qu'elle est ouverte.
 */
public class MainActivity extends Activity {
    static final String STOP = "app.hubs.STOP";
    private static final int DEFAULT_PORT = 8443; // port HTTPS du serveur
    private static final int ASK_NOTIFICATIONS = 1, ASK_MICROPHONE = 2;

    private SharedPreferences prefs;
    private View start;
    private FrameLayout stage;
    private EditText address;
    private TextView message;
    private WebView web;
    private PermissionRequest waitingForMicrophone;

    /**
     * Une page masquée est ralentie par le moteur (minuteries espacées, rendu suspendu), ce qui
     * dérègle l'asservissement du son. Écran éteint, la page doit croire qu'elle reste affichée.
     */
    private static class AlwaysVisibleWebView extends WebView {
        AlwaysVisibleWebView(Context context) {
            super(context);
        }

        @Override
        protected void onWindowVisibilityChanged(int visibility) {
            if (visibility != View.GONE) super.onWindowVisibilityChanged(View.VISIBLE);
        }
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.main);
        prefs = getSharedPreferences("hubs", MODE_PRIVATE);
        start = findViewById(R.id.start);
        stage = findViewById(R.id.stage);
        address = findViewById(R.id.address);
        message = findViewById(R.id.message);
        address.setText(prefs.getString("address", ""));
        findViewById(R.id.open).setOnClickListener((v) -> open(address.getText().toString()));
        address.setOnEditorActionListener((v, action, event) -> {
            if (action != EditorInfo.IME_ACTION_GO) return false;
            open(address.getText().toString());
            return true;
        });
        // Au lancement, on rouvre la dernière salle sans rien demander, sauf si un lien en désigne une autre.
        if (!openLink(getIntent()) && !STOP.equals(getIntent().getAction()) && !prefs.getString("address", "").isEmpty()) open(prefs.getString("address", ""));
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (STOP.equals(intent.getAction())) close("");
        else openLink(intent);
    }

    // Lien hubs://hôte:port/r/CODE, proposé par la page d'une salle ouverte dans le navigateur. N'importe
    // quelle page peut fabriquer un tel lien : un serveur jamais utilisé demande confirmation.
    private boolean openLink(Intent intent) {
        Uri link = intent.getData();
        if (!Intent.ACTION_VIEW.equals(intent.getAction()) || link == null || !"hubs".equals(link.getScheme()) || link.getHost() == null) return false;
        String url = "https" + link.toString().substring("hubs".length());
        String host = Uri.parse(url).getAuthority();
        Uri last = Uri.parse(prefs.getString("address", ""));
        if (host.equals(last.getAuthority()) || prefs.contains("cert:" + host)) {
            open(url);
            return true;
        }
        new AlertDialog.Builder(this)
                .setTitle(R.string.link_title)
                .setMessage(getString(R.string.link_message, host))
                .setPositiveButton(R.string.open, (dialog, which) -> open(url))
                .setNegativeButton(R.string.cancel, null)
                .show();
        return true;
    }

    // "192.168.1.12" -> "https://192.168.1.12:8443/" ; un lien complet est gardé tel quel.
    static String normalize(String input) {
        String text = input.trim();
        if (text.isEmpty()) return null;
        Uri uri = Uri.parse(text.contains("://") ? text : "https://" + text);
        if (uri.getHost() == null || uri.getHost().isEmpty()) return null;
        if (uri.getPort() == -1 && !text.contains("://")) uri = uri.buildUpon().encodedAuthority(uri.getHost() + ":" + DEFAULT_PORT).build();
        return uri.getPath() == null || uri.getPath().isEmpty() ? uri + "/" : uri.toString();
    }

    private void open(String input) {
        String url = normalize(input);
        if (url == null) {
            address.requestFocus();
            return;
        }
        getSystemService(InputMethodManager.class).hideSoftInputFromWindow(address.getWindowToken(), 0);
        if (web != null) close("");
        message.setText("");

        web = new AlwaysVisibleWebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); // la page y garde son nom, son identifiant et sa compensation
        settings.setMediaPlaybackRequiresUserGesture(false);
        // La page s'en sert pour ne pas proposer d'« Ouvrir dans l'application » à l'application elle-même.
        settings.setUserAgentString(settings.getUserAgentString() + " HubsApp");
        // Le moteur de rendu ne doit pas perdre sa priorité quand l'écran s'éteint.
        web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        web.setWebViewClient(new Pages());
        web.setWebChromeClient(new Permissions());
        stage.addView(web, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        stage.setVisibility(View.VISIBLE);
        start.setVisibility(View.GONE);
        web.loadUrl(url);

        startForegroundService(new Intent(this, PlaybackService.class));
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, ASK_NOTIFICATIONS);
        }
    }

    // Ferme la page (le son s'arrête) et revient à l'écran d'adresse.
    private void close(String why) {
        stopService(new Intent(this, PlaybackService.class));
        if (web != null) {
            stage.removeAllViews();
            web.destroy();
            web = null;
        }
        waitingForMicrophone = null;
        stage.setVisibility(View.GONE);
        start.setVisibility(View.VISIBLE);
        // Après une erreur, l'adresse saisie reste là pour être corrigée ; sinon, celle de la dernière page vue.
        if (why.isEmpty()) address.setText(prefs.getString("address", ""));
        message.setText(why);
    }

    @Override
    @SuppressWarnings("deprecation") // suffit tant que l'application ne demande pas le geste de retour prédictif
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else if (web != null) moveTaskToBack(true); // comme un lecteur de musique : le son continue, « Arrêter » est dans la notification
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) close("");
        super.onDestroy();
    }

    private class Pages extends WebViewClient {
        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            // La prochaine ouverture reprendra sur cette page : la salle, pas l'accueil du serveur.
            if (url.startsWith("http")) prefs.edit().putString("address", url).apply();
        }

        // Le serveur lancé sur un ordinateur a un certificat auto-signé. On ne l'accepte pas les yeux
        // fermés : l'utilisateur valide son empreinte une fois, et seul ce certificat-là passe ensuite.
        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            String host = Uri.parse(error.getUrl()).getAuthority();
            String print = fingerprint(error.getCertificate());
            if (print != null && print.equals(prefs.getString("cert:" + host, null))) {
                handler.proceed();
                return;
            }
            if (print == null || view != web) {
                handler.cancel();
                return;
            }
            new AlertDialog.Builder(MainActivity.this)
                    .setTitle(R.string.cert_title)
                    .setMessage(getString(R.string.cert_message, host, print))
                    .setCancelable(false)
                    .setPositiveButton(R.string.cert_trust, (dialog, which) -> {
                        prefs.edit().putString("cert:" + host, print).apply();
                        handler.proceed();
                    })
                    .setNegativeButton(R.string.cancel, (dialog, which) -> {
                        handler.cancel();
                        if (view == web) close(getString(R.string.cert_refused));
                    })
                    .show();
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (view == web && request.isForMainFrame()) close(getString(R.string.unreachable, error.getDescription()));
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            if (view == web) close(getString(R.string.page_crashed));
            return true; // sans cela, l'application entière serait tuée avec la page
        }
    }

    private class Permissions extends WebChromeClient {
        // La page demande le micro quand ce téléphone est choisi pour écouter.
        @Override
        public void onPermissionRequest(PermissionRequest request) {
            runOnUiThread(() -> {
                boolean microphone = false;
                for (String resource : request.getResources()) microphone |= PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource);
                if (!microphone || web == null) {
                    request.deny();
                } else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                } else {
                    waitingForMicrophone = request;
                    requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, ASK_MICROPHONE);
                }
            });
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        if (code != ASK_MICROPHONE || waitingForMicrophone == null) return;
        PermissionRequest request = waitingForMicrophone;
        waitingForMicrophone = null;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
        else request.deny();
    }

    // Empreinte SHA-256 du certificat, sous la forme qu'affiche le serveur : "AB:CD:…".
    static String fingerprint(SslCertificate certificate) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(certificate.getX509Certificate().getEncoded());
            StringBuilder out = new StringBuilder();
            for (byte b : hash) out.append(out.length() > 0 ? ":" : "").append(String.format("%02X", b));
            return out.toString();
        } catch (Exception e) {
            return null;
        }
    }
}
