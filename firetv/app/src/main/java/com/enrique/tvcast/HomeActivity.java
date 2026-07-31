package com.enrique.tvcast;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

public class HomeActivity extends Activity {

    private static final String LOG_TAG = "tvcast";
    private static final int MILLISECONDS_PER_SECOND = 1000;
    private static final String EMPTY_STRING = "";

    private final Handler handler = new Handler(Looper.getMainLooper());

    private LinearLayout listContainer;
    private TextView statusView;

    public static final String EXTRA_PLAYBACK = "playback";

    public static Intent buildPlaybackIntent(android.content.Context context, String playbackJson) {
        Intent intent = new Intent(context, HomeActivity.class);
        intent.putExtra(EXTRA_PLAYBACK, playbackJson);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return intent;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildLayout();
        forwardPlaybackIfPresent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        forwardPlaybackIfPresent(intent);
    }

    private void forwardPlaybackIfPresent(Intent intent) {
        if (intent == null) {
            return;
        }
        String payload = intent.getStringExtra(EXTRA_PLAYBACK);
        if (payload == null || payload.length() == 0) {
            return;
        }
        intent.removeExtra(EXTRA_PLAYBACK);
        startActivity(PlayerActivity.buildIntent(this, payload));
    }

    @Override
    protected void onResume() {
        super.onResume();
        PlaybackBridgeService.ensureRunning(this);
        collectPendingPlayback();
        loadCatalogue();
    }

    private void collectPendingPlayback() {
        final String baseUrl = ServerLocator.getBaseUrl(this);
        if (baseUrl.length() == 0) {
            return;
        }
        new Thread(() -> {
            try {
                final String payload = ServerApi.get(baseUrl + "/api/pending");
                if (payload.length() > 0) {
                    handler.post(() -> startActivity(PlayerActivity.buildIntent(HomeActivity.this, payload)));
                }
            } catch (Exception error) {
                Log.d(LOG_TAG, "no pending item: " + error.getMessage());
            }
        }).start();
    }

    private void buildLayout() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0b0f14"));
        root.setPadding(64, 48, 64, 48);

        TextView heading = new TextView(this);
        heading.setText("tvcast");
        heading.setTextColor(Color.parseColor("#6db3ff"));
        heading.setTextSize(34);
        root.addView(heading);

        statusView = new TextView(this);
        statusView.setTextColor(Color.parseColor("#8b9bb0"));
        statusView.setTextSize(16);
        statusView.setPadding(0, 8, 0, 24);
        root.addView(statusView);

        ScrollView scroller = new ScrollView(this);
        listContainer = new LinearLayout(this);
        listContainer.setOrientation(LinearLayout.VERTICAL);
        scroller.addView(listContainer, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(scroller, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);
    }

    private void loadCatalogue() {
        final String baseUrl = ServerLocator.getBaseUrl(this);
        if (baseUrl.length() == 0) {
            statusView.setText("No PC configured yet. Send something from your phone first.");
            return;
        }
        statusView.setText("Loading from " + baseUrl);
        new Thread(() -> {
            try {
                final String body = ServerApi.get(baseUrl + "/api/catalogue");
                final JSONArray items = new JSONObject(body).getJSONArray("items");
                handler.post(() -> renderCatalogue(items, baseUrl));
            } catch (Exception error) {
                Log.w(LOG_TAG, "catalogue load failed", error);
                handler.post(() -> statusView.setText("Cannot reach the PC at " + baseUrl));
            }
        }).start();
    }

    private void renderCatalogue(JSONArray items, String baseUrl) {
        listContainer.removeAllViews();
        if (items.length() == 0) {
            statusView.setText("Nothing sent yet. Paste a link on your phone.");
            return;
        }
        statusView.setText(items.length() + " ready to watch");
        for (int index = 0; index < items.length(); index += 1) {
            JSONObject item = items.optJSONObject(index);
            if (item != null) {
                listContainer.addView(buildRow(item, baseUrl));
            }
        }
        if (listContainer.getChildCount() > 0) {
            listContainer.getChildAt(0).requestFocus();
        }
    }

    private View buildRow(JSONObject item, String baseUrl) {
        final String publicationId = item.optString("id");
        String title = item.optString("title");
        long durationSeconds = item.optLong("durationSeconds", 0);
        String quality = item.optString("quality", EMPTY_STRING);
        String subtitle = item.optString("selectedSubtitleId", EMPTY_STRING);

        StringBuilder detail = new StringBuilder();
        if (durationSeconds > 0) {
            detail.append(formatDuration(durationSeconds));
        }
        if (quality.length() > 0) {
            detail.append("  ").append(quality);
        }
        if (subtitle.length() > 0) {
            detail.append("  subtitles: ").append(subtitle);
        }

        Button row = new Button(this);
        row.setText(title + "\n" + detail.toString().trim());
        row.setTextSize(19);
        row.setTextColor(Color.WHITE);
        row.setAllCaps(false);
        row.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        row.setPadding(32, 24, 32, 24);
        row.setBackgroundColor(Color.parseColor("#161c24"));
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        layout.bottomMargin = 12;
        row.setLayoutParams(layout);
        row.setOnFocusChangeListener((view, focused) ->
                view.setBackgroundColor(Color.parseColor(focused ? "#26405c" : "#161c24")));
        row.setOnClickListener(view -> openPublication(publicationId, baseUrl));
        return row;
    }

    private void openPublication(String publicationId, String baseUrl) {
        statusView.setText("Starting...");
        new Thread(() -> {
            try {
                final String payload = ServerApi.get(baseUrl + "/api/play/" + publicationId);
                handler.post(() -> startActivity(PlayerActivity.buildIntent(HomeActivity.this, payload)));
            } catch (Exception error) {
                Log.w(LOG_TAG, "could not start publication", error);
                handler.post(() -> statusView.setText("Could not start that item: " + error.getMessage()));
            }
        }).start();
    }

    private String formatDuration(long totalSeconds) {
        long hours = totalSeconds / 3600;
        long minutes = (totalSeconds % 3600) / 60;
        if (hours > 0) {
            return hours + "h " + minutes + "m";
        }
        return minutes + "m";
    }
}
