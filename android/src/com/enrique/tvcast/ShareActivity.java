package com.enrique.tvcast;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.widget.EditText;
import android.widget.Toast;

import org.json.JSONObject;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class ShareActivity extends Activity {

    private static final Pattern URL_PATTERN = Pattern.compile("https?://\\S+");
    private static final String CAST_PATH = "/api/cast-url";
    private static final String DOWNLOAD_PATH = "/api/download";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        String sharedUrl = extractUrl(getIntent());
        if (sharedUrl == null) {
            Toast.makeText(this, "No link found in that share", Toast.LENGTH_LONG).show();
            finish();
        } else {
            askWhatToDo(sharedUrl);
        }
    }

    private String extractUrl(Intent intent) {
        String candidate = null;
        if (intent != null) {
            if (intent.getData() != null) {
                candidate = intent.getData().toString().replaceFirst("^tvcast://", "");
            } else {
                candidate = intent.getStringExtra(Intent.EXTRA_TEXT);
            }
        }
        if (candidate == null) {
            return null;
        }
        Matcher matcher = URL_PATTERN.matcher(candidate);
        if (matcher.find()) {
            return matcher.group();
        }
        return null;
    }

    private void askWhatToDo(final String sharedUrl) {
        String preview = sharedUrl.length() > 70 ? sharedUrl.substring(0, 70) + "…" : sharedUrl;
        new AlertDialog.Builder(this)
                .setTitle("Send to TV")
                .setMessage(preview)
                .setPositiveButton("Watch now", (dialog, which) -> submit(CAST_PATH, sharedUrl, "Resolving…"))
                .setNeutralButton("Download", (dialog, which) -> submit(DOWNLOAD_PATH, sharedUrl, "Queued"))
                .setNegativeButton("Cancel", (dialog, which) -> finish())
                .setOnCancelListener(dialog -> finish())
                .show();
    }

    private void submit(final String path, final String sharedUrl, final String pendingMessage) {
        Toast.makeText(this, pendingMessage, Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            try {
                JSONObject payload = new JSONObject();
                payload.put("url", sharedUrl);
                String responseText = ServerConfig.postJson(ShareActivity.this, path, payload);
                String title = new JSONObject(responseText).optString("title", "sent");
                showResultAndFinish(CAST_PATH.equals(path) ? ("Playing: " + title) : "Download started");
            } catch (Exception error) {
                showFailure(error.getMessage() == null ? "unreachable" : error.getMessage());
            }
        }).start();
    }

    private void showResultAndFinish(final String message) {
        mainHandler.post(() -> {
            Toast.makeText(ShareActivity.this, message, Toast.LENGTH_LONG).show();
            finish();
        });
    }

    private void showFailure(final String message) {
        mainHandler.post(() -> {
            new AlertDialog.Builder(ShareActivity.this)
                    .setTitle("Could not reach TV Cast")
                    .setMessage(message + "\n\nServer: " + ServerConfig.getBaseUrl(ShareActivity.this))
                    .setPositiveButton("Change address", (dialog, which) -> promptForAddress())
                    .setNegativeButton("Close", (dialog, which) -> finish())
                    .setOnCancelListener(dialog -> finish())
                    .show();
        });
    }

    private void promptForAddress() {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(ServerConfig.getBaseUrl(this));
        new AlertDialog.Builder(this)
                .setTitle("Server address")
                .setView(input)
                .setPositiveButton("Save", (dialog, which) -> {
                    ServerConfig.setBaseUrl(ShareActivity.this, input.getText().toString());
                    Toast.makeText(ShareActivity.this, "Saved. Share the link again.", Toast.LENGTH_LONG).show();
                    finish();
                })
                .setNegativeButton("Cancel", (dialog, which) -> finish())
                .setOnCancelListener(dialog -> finish())
                .show();
    }
}
