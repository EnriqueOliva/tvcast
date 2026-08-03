package com.enrique.capytv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.widget.Toast;

import org.json.JSONObject;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

// Share a link from YouTube, Chrome or anywhere else and it goes straight to the tv,
// without opening the app first.
public class ShareActivity extends Activity {

    private static final String LOG_TAG = ServerConfig.LOG_TAG;
    private static final String EMPTY_STRING = "";
    private static final Pattern URL_PATTERN = Pattern.compile("https?://\\S+");
    private static final String CAPYTV_SCHEME_PREFIX = "capytv://";
    private static final String SEND_ROUTE = "/api/send";
    private static final String DOWNLOAD_ROUTE = "/api/download";

    private final Handler handler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String sharedUrl = extractUrl(getIntent());
        if (sharedUrl.length() == 0) {
            finishWithMessage("No link in what you shared");
        } else {
            askWhatToDo(sharedUrl);
        }
    }

    private String extractUrl(Intent intent) {
        if (intent == null) {
            return EMPTY_STRING;
        }
        String candidate = EMPTY_STRING;
        if (intent.getData() != null) {
            candidate = intent.getData().toString();
            if (candidate.startsWith(CAPYTV_SCHEME_PREFIX)) {
                candidate = candidate.substring(CAPYTV_SCHEME_PREFIX.length());
            }
        }
        if (candidate.length() == 0) {
            CharSequence shared = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            candidate = shared == null ? EMPTY_STRING : shared.toString();
        }
        Matcher matched = URL_PATTERN.matcher(candidate);
        if (matched.find()) {
            return matched.group();
        }
        return EMPTY_STRING;
    }

    private void askWhatToDo(final String sharedUrl) {
        new AlertDialog.Builder(this)
                .setTitle("capyTV")
                .setMessage(sharedUrl)
                .setPositiveButton("play on the tv", (dialog, which) -> submit(sharedUrl, SEND_ROUTE))
                .setNeutralButton("save on the pc", (dialog, which) -> submit(sharedUrl, DOWNLOAD_ROUTE))
                .setNegativeButton("cancel", (dialog, which) -> finish())
                .setOnCancelListener(dialog -> finish())
                .show();
    }

    private void submit(final String sharedUrl, final String route) {
        Toast.makeText(this,
                route.equals(SEND_ROUTE) ? "Sending to the tv..." : "Saving on the pc...",
                Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            String failure = EMPTY_STRING;
            String success = EMPTY_STRING;
            try {
                String baseUrl = ServerConfig.resolveBaseUrl(ShareActivity.this);
                if (baseUrl.length() == 0) {
                    failure = "Could not find the pc on this wifi";
                } else {
                    JSONObject body = new JSONObject();
                    body.put("url", sharedUrl);
                    String reply = ServerApi.post(baseUrl + route, body.toString());
                    success = describeReply(route, reply);
                }
            } catch (Exception error) {
                Log.w(LOG_TAG, "share failed", error);
                failure = shorten(error.getMessage());
            }
            final String failureMessage = failure;
            final String successMessage = success;
            handler.post(() -> {
                if (failureMessage.length() == 0) {
                    finishWithMessage(successMessage);
                } else {
                    showFailure(sharedUrl, route, failureMessage);
                }
            });
        }, "capytv-share").start();
    }

    private String describeReply(String route, String reply) {
        if (route.equals(DOWNLOAD_ROUTE)) {
            return "Saving on the pc";
        }
        try {
            JSONObject parsed = new JSONObject(reply);
            String title = parsed.optString("title", EMPTY_STRING);
            if (parsed.optBoolean("delivered", false)) {
                return title.length() == 0 ? "Playing on the tv" : "Playing: " + title;
            }
            return "Queued, the tv will pick it up when it wakes";
        } catch (Exception error) {
            return "Sent to the pc";
        }
    }

    private String shorten(String message) {
        String text = message == null ? "something went wrong" : message;
        if (text.length() > 160) {
            return text.substring(0, 160);
        }
        return text;
    }

    private void showFailure(final String sharedUrl, final String route, String reason) {
        new AlertDialog.Builder(this)
                .setTitle("capyTV could not do that")
                .setMessage(reason)
                .setPositiveButton("try again", (dialog, which) -> submit(sharedUrl, route))
                .setNeutralButton("change address", (dialog, which) -> promptForAddress(sharedUrl, route))
                .setNegativeButton("give up", (dialog, which) -> finish())
                .setOnCancelListener(dialog -> finish())
                .show();
    }

    private void promptForAddress(final String sharedUrl, final String route) {
        final android.widget.EditText input = new android.widget.EditText(this);
        input.setHint("192.168.1.8");
        input.setText(ServerConfig.getBaseUrl(this));
        new AlertDialog.Builder(this)
                .setTitle("Address of the pc")
                .setView(input)
                .setPositiveButton("save", (dialog, which) -> {
                    String typed = ServerConfig.normalise(input.getText().toString());
                    if (typed.length() > 0) {
                        ServerConfig.setBaseUrl(this, typed);
                        submit(sharedUrl, route);
                    } else {
                        finish();
                    }
                })
                .setNegativeButton("cancel", (dialog, which) -> finish())
                .setOnCancelListener(dialog -> finish())
                .show();
    }

    private void finishWithMessage(String message) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
        finish();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
