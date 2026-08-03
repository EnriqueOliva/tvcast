package com.enrique.capytv;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {

    private static final String LOG_TAG = ServerConfig.LOG_TAG;
    private static final String EMPTY_STRING = "";
    private static final String BACKGROUND_COLOUR = "#0b0d10";
    private static final String ACCENT_COLOUR = "#4da3ff";
    private static final String MUTED_COLOUR = "#8b98a7";
    private static final int HEADING_TEXT_SIZE = 26;
    private static final int MESSAGE_TEXT_SIZE = 15;
    private static final int BUTTON_TEXT_SIZE = 16;
    private static final int PANEL_PADDING = 48;
    private static final int BUTTON_TOP_MARGIN = 20;

    private final Handler handler = new Handler(Looper.getMainLooper());

    private FrameLayout root;
    private WebView webView;
    private LinearLayout setupPanel;
    private TextView setupMessage;
    private Button searchButton;

    private String baseUrl = EMPTY_STRING;
    private boolean searching;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildLayout();
        findServerThenLoad();
    }

    private void buildLayout() {
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor(BACKGROUND_COLOUR));

        // Lets tools/device-tests.cjs drive the real page in the real app over the
        // devtools protocol, so the phone can be tested by clicking what you actually click.
        WebView.setWebContentsDebuggingEnabled(true);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor(BACKGROUND_COLOUR));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setMediaPlaybackRequiresUserGesture(false);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    Log.w(LOG_TAG, "page failed: " + error.getDescription());
                    showSetupPanel("Lost the pc at " + baseUrl + ".");
                }
            }
        });
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        buildSetupPanel();
        setContentView(root);
    }

    private void buildSetupPanel() {
        setupPanel = new LinearLayout(this);
        setupPanel.setOrientation(LinearLayout.VERTICAL);
        setupPanel.setGravity(Gravity.CENTER);
        setupPanel.setBackgroundColor(Color.parseColor(BACKGROUND_COLOUR));
        setupPanel.setPadding(PANEL_PADDING, PANEL_PADDING, PANEL_PADDING, PANEL_PADDING);
        setupPanel.setVisibility(View.GONE);

        TextView heading = new TextView(this);
        heading.setText("capyTV");
        heading.setTextColor(Color.parseColor(ACCENT_COLOUR));
        heading.setTextSize(HEADING_TEXT_SIZE);
        heading.setGravity(Gravity.CENTER);
        setupPanel.addView(heading);

        setupMessage = new TextView(this);
        setupMessage.setTextColor(Color.parseColor(MUTED_COLOUR));
        setupMessage.setTextSize(MESSAGE_TEXT_SIZE);
        setupMessage.setGravity(Gravity.CENTER);
        setupMessage.setPadding(0, 16, 0, 0);
        setupPanel.addView(setupMessage);

        searchButton = new Button(this);
        searchButton.setText("search for the pc");
        searchButton.setTextSize(BUTTON_TEXT_SIZE);
        searchButton.setAllCaps(false);
        searchButton.setOnClickListener(view -> findServerThenLoad());
        LinearLayout.LayoutParams searchLayout = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        searchLayout.topMargin = BUTTON_TOP_MARGIN;
        setupPanel.addView(searchButton, searchLayout);

        Button addressButton = new Button(this);
        addressButton.setText("type the address instead");
        addressButton.setTextSize(BUTTON_TEXT_SIZE);
        addressButton.setAllCaps(false);
        addressButton.setOnClickListener(view -> promptForAddress());
        setupPanel.addView(addressButton, searchLayout);

        root.addView(setupPanel, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void showSetupPanel(String message) {
        setupMessage.setText(message);
        searchButton.setEnabled(searching == false);
        setupPanel.setVisibility(View.VISIBLE);
    }

    private void hideSetupPanel() {
        setupPanel.setVisibility(View.GONE);
    }

    private void findServerThenLoad() {
        if (searching) {
            return;
        }
        searching = true;
        showSetupPanel("Looking for the pc on this wifi...");
        new Thread(() -> {
            final String found = ServerConfig.resolveBaseUrl(MainActivity.this);
            handler.post(() -> {
                searching = false;
                if (found.length() == 0) {
                    showSetupPanel("Could not find the pc. Check it is awake and on the same wifi.");
                } else {
                    baseUrl = found;
                    hideSetupPanel();
                    webView.loadUrl(found);
                    Log.i(LOG_TAG, "loaded " + found);
                }
            });
        }, "capytv-find").start();
    }

    private void promptForAddress() {
        final EditText input = new EditText(this);
        input.setHint("192.168.1.8");
        input.setText(ServerConfig.getBaseUrl(this));
        new AlertDialog.Builder(this)
                .setTitle("Address of the pc")
                .setView(input)
                .setPositiveButton("save", (dialog, which) -> {
                    String typed = ServerConfig.normalise(input.getText().toString());
                    if (typed.length() > 0) {
                        ServerConfig.setBaseUrl(this, typed);
                        baseUrl = typed;
                        hideSetupPanel();
                        webView.loadUrl(typed);
                    }
                })
                .setNegativeButton("cancel", null)
                .show();
    }

    @Override
    public void onBackPressed() {
        if (setupPanel.getVisibility() != View.VISIBLE && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
