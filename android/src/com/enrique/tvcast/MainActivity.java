package com.enrique.tvcast;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.text.InputType;
import android.view.Menu;
import android.view.MenuItem;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

public class MainActivity extends Activity {

    private static final int MENU_ITEM_RELOAD = 1;
    private static final int MENU_ITEM_ADDRESS = 2;

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        webView.setWebViewClient(new WebViewClient());
        setContentView(webView);

        webView.loadUrl(ServerConfig.getBaseUrl(this));
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        menu.add(Menu.NONE, MENU_ITEM_RELOAD, Menu.NONE, "Reload");
        menu.add(Menu.NONE, MENU_ITEM_ADDRESS, Menu.NONE, "Server address");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == MENU_ITEM_RELOAD) {
            webView.loadUrl(ServerConfig.getBaseUrl(this));
            return true;
        } else if (item.getItemId() == MENU_ITEM_ADDRESS) {
            promptForAddress();
            return true;
        } else {
            return super.onOptionsItemSelected(item);
        }
    }

    private void promptForAddress() {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(ServerConfig.getBaseUrl(this));
        new AlertDialog.Builder(this)
                .setTitle("Server address")
                .setView(input)
                .setPositiveButton("Save", (dialog, which) -> {
                    ServerConfig.setBaseUrl(MainActivity.this, input.getText().toString());
                    webView.loadUrl(ServerConfig.getBaseUrl(MainActivity.this));
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
