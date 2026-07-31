package com.enrique.tvcast;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionParameters;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.PlayerView;
import androidx.media3.ui.SubtitleView;

import org.json.JSONArray;
import org.json.JSONObject;

public class PlayerActivity extends Activity {

    public static final String EXTRA_PLAYBACK = "playback";

    private static final String LOG_TAG = "tvcast";
    private static final int SEEK_BACK_MILLISECONDS = 10000;
    private static final int SEEK_FORWARD_MILLISECONDS = 30000;
    private static final int SUBTITLE_STEP_MILLISECONDS = 100;
    private static final int PROGRESS_INTERVAL_MILLISECONDS = 10000;
    private static final int NOTICE_DURATION_MILLISECONDS = 2500;
    private static final int MILLISECONDS_PER_SECOND = 1000;
    private static final int BUFFER_MINIMUM_MILLISECONDS = 20000;
    private static final int BUFFER_MAXIMUM_MILLISECONDS = 60000;
    private static final int BUFFER_FOR_PLAYBACK_MILLISECONDS = 2000;
    private static final int BUFFER_AFTER_REBUFFER_MILLISECONDS = 5000;
    private static final int SUBTITLE_OFF_INDEX = -1;
    private static final String EMPTY_STRING = "";

    private final Handler handler = new Handler(Looper.getMainLooper());

    private ExoPlayer player;
    private PlayerView playerView;
    private SubtitleView subtitleView;
    private TextView noticeView;
    private SubtitleController subtitleController;

    private JSONObject playback;
    private JSONArray subtitleTracks;
    private int selectedSubtitleIndex = SUBTITLE_OFF_INDEX;
    private String contentKey = EMPTY_STRING;
    private String serverBaseUrl = EMPTY_STRING;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setTurnScreenOn(true);
        getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        buildLayout();
        liveInstance = this;
        applyPlayback(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        releasePlayer();
        applyPlayback(intent);
    }

    private void buildLayout() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        playerView = new PlayerView(this);
        playerView.setUseController(true);
        playerView.setShowSubtitleButton(false);
        playerView.setControllerShowTimeoutMs(4000);
        root.addView(playerView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        subtitleView = new SubtitleView(this);
        root.addView(subtitleView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        noticeView = new TextView(this);
        noticeView.setTextColor(Color.WHITE);
        noticeView.setBackgroundColor(0xB3000000);
        noticeView.setTextSize(20);
        noticeView.setPadding(28, 16, 28, 16);
        noticeView.setVisibility(TextView.GONE);
        FrameLayout.LayoutParams noticeLayout = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        noticeLayout.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        noticeLayout.topMargin = 48;
        root.addView(noticeView, noticeLayout);

        setContentView(root);
    }

    private void applyPlayback(Intent intent) {
        String payload = intent == null ? null : intent.getStringExtra(EXTRA_PLAYBACK);
        if (payload == null || payload.length() == 0) {
            showNotice("Nothing to play");
            finish();
            return;
        }
        try {
            playback = new JSONObject(payload);
        } catch (Exception error) {
            showNotice("That item could not be read");
            finish();
            return;
        }
        contentKey = playback.optString("contentKey", EMPTY_STRING);
        serverBaseUrl = playback.optString("serverBaseUrl", ServerLocator.getBaseUrl(this));
        subtitleTracks = playback.optJSONArray("subtitles");
        if (subtitleTracks == null) {
            subtitleTracks = new JSONArray();
        }
        ServerLocator.setBaseUrl(this, serverBaseUrl);
        startPlayer();
    }

    private void startPlayer() {
        DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(
                        BUFFER_MINIMUM_MILLISECONDS,
                        BUFFER_MAXIMUM_MILLISECONDS,
                        BUFFER_FOR_PLAYBACK_MILLISECONDS,
                        BUFFER_AFTER_REBUFFER_MILLISECONDS)
                .build();

        player = new ExoPlayer.Builder(this)
                .setSeekBackIncrementMs(SEEK_BACK_MILLISECONDS)
                .setSeekForwardIncrementMs(SEEK_FORWARD_MILLISECONDS)
                .setLoadControl(loadControl)
                .build();
        playerView.setPlayer(player);

        player.setTrackSelectionParameters(
                player.getTrackSelectionParameters().buildUpon()
                        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                        .build());

        subtitleController = new SubtitleController(subtitleView, player);

        player.addListener(new Player.Listener() {
            @Override
            public void onPlayerError(PlaybackException error) {
                Log.e(LOG_TAG, "playback error " + error.getErrorCodeName(), error);
                showNotice("Playback failed: " + error.getErrorCodeName());
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_ENDED) {
                    reportProgress();
                    finish();
                }
            }
        });

        MediaItem.Builder itemBuilder = new MediaItem.Builder().setUri(playback.optString("mediaUrl"));
        if (playback.optString("mediaKind", "hls").equals("hls")) {
            itemBuilder.setMimeType(MimeTypes.APPLICATION_M3U8);
        }
        MediaItem item = itemBuilder.build();
        player.setMediaItem(item);
        player.prepare();

        long resumeMilliseconds = playback.optLong("resumeMilliseconds", 0);
        if (resumeMilliseconds > 0) {
            player.seekTo(resumeMilliseconds);
            showNotice("Resumed at " + formatTime(resumeMilliseconds));
        }
        player.setPlayWhenReady(true);
        playerView.requestFocus();

        subtitleController.setOffsetMilliseconds(playback.optLong("subtitleOffsetMilliseconds", 0));
        subtitleController.start();
        selectInitialSubtitle();
        handler.postDelayed(progressReporter, PROGRESS_INTERVAL_MILLISECONDS);
    }

    private void selectInitialSubtitle() {
        String wanted = playback.optString("selectedSubtitleId", EMPTY_STRING);
        for (int index = 0; index < subtitleTracks.length(); index += 1) {
            if (subtitleTracks.optJSONObject(index).optString("id").equals(wanted)) {
                loadSubtitle(index, false);
                return;
            }
        }
        selectedSubtitleIndex = SUBTITLE_OFF_INDEX;
    }

    private void loadSubtitle(final int index, final boolean announce) {
        if (index == SUBTITLE_OFF_INDEX) {
            selectedSubtitleIndex = SUBTITLE_OFF_INDEX;
            subtitleController.setCueTrack(CueTrack.empty());
            if (announce) {
                showNotice("Subtitles off");
            }
            return;
        }
        final JSONObject track = subtitleTracks.optJSONObject(index);
        if (track == null) {
            return;
        }
        selectedSubtitleIndex = index;
        final String cuesUrl = track.optString("cuesUrl");
        final String language = track.optString("language");
        new Thread(() -> {
            try {
                final String body = ServerApi.get(cuesUrl);
                final CueTrack parsed = CueTrack.parse(body);
                handler.post(() -> {
                    subtitleController.setCueTrack(parsed);
                    if (announce) {
                        showNotice("Subtitles: " + language);
                    }
                });
            } catch (Exception error) {
                Log.e(LOG_TAG, "subtitle load failed", error);
                handler.post(() -> showNotice("Could not load " + language + " subtitles"));
            }
        }).start();
    }

    private void cycleSubtitle() {
        int next = selectedSubtitleIndex + 1;
        if (next >= subtitleTracks.length()) {
            next = SUBTITLE_OFF_INDEX;
        }
        loadSubtitle(next, true);
    }

    private void nudgeSubtitle(int deltaMilliseconds) {
        if (subtitleController.hasCues() == false) {
            showNotice("No subtitles to shift");
            return;
        }
        long updated = subtitleController.getOffsetMilliseconds() + deltaMilliseconds;
        subtitleController.setOffsetMilliseconds(updated);
        double seconds = updated / (double) MILLISECONDS_PER_SECOND;
        showNotice(String.format("Subtitles %+.1f s", seconds));
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() != KeyEvent.ACTION_DOWN || player == null) {
            return super.dispatchKeyEvent(event);
        }
        int code = event.getKeyCode();
        Log.i(LOG_TAG, "key " + code + " " + KeyEvent.keyCodeToString(code));
        boolean controllerVisible = playerView.isControllerFullyVisible();

        if (code == KeyEvent.KEYCODE_BACK) {
            reportProgress();
            finish();
            return true;
        } else if (code == KeyEvent.KEYCODE_MENU) {
            cycleSubtitle();
            return true;
        } else if (code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || code == KeyEvent.KEYCODE_MEDIA_PLAY
                || code == KeyEvent.KEYCODE_MEDIA_PAUSE) {
            togglePlayback();
            return true;
        } else if (code == KeyEvent.KEYCODE_MEDIA_REWIND) {
            player.seekBack();
            return true;
        } else if (code == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD) {
            player.seekForward();
            return true;
        } else if (controllerVisible == false && code == KeyEvent.KEYCODE_DPAD_LEFT) {
            player.seekBack();
            showNotice("-10 s");
            return true;
        } else if (controllerVisible == false && code == KeyEvent.KEYCODE_DPAD_RIGHT) {
            player.seekForward();
            showNotice("+30 s");
            return true;
        } else if (controllerVisible == false && code == KeyEvent.KEYCODE_DPAD_UP) {
            nudgeSubtitle(SUBTITLE_STEP_MILLISECONDS);
            return true;
        } else if (controllerVisible == false && code == KeyEvent.KEYCODE_DPAD_DOWN) {
            nudgeSubtitle(-SUBTITLE_STEP_MILLISECONDS);
            return true;
        } else {
            return super.dispatchKeyEvent(event);
        }
    }

    private void togglePlayback() {
        if (player.isPlaying()) {
            player.pause();
        } else {
            player.play();
        }
    }

    private final Runnable progressReporter = new Runnable() {
        @Override
        public void run() {
            reportProgress();
            handler.postDelayed(this, PROGRESS_INTERVAL_MILLISECONDS);
        }
    };

    private void reportProgress() {
        if (player == null || contentKey.length() == 0 || serverBaseUrl.length() == 0) {
            return;
        }
        final long position = player.getCurrentPosition();
        final long duration = player.getDuration();
        Log.i(LOG_TAG, "position=" + position + " duration=" + duration
                + " playing=" + player.isPlaying()
                + " subtitleOffset=" + (subtitleController == null ? 0 : subtitleController.getOffsetMilliseconds())
                + " cues=" + (subtitleController == null ? 0 : (subtitleController.hasCues() ? 1 : 0)));
        final long offset = subtitleController == null ? 0 : subtitleController.getOffsetMilliseconds();
        final String subtitleId = selectedSubtitleIndex == SUBTITLE_OFF_INDEX
                ? EMPTY_STRING
                : subtitleTracks.optJSONObject(selectedSubtitleIndex).optString("id");
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("contentKey", contentKey);
                body.put("positionMilliseconds", position);
                body.put("durationMilliseconds", duration);
                body.put("subtitleId", subtitleId);
                body.put("subtitleOffsetMilliseconds", offset);
                ServerApi.post(serverBaseUrl + "/api/progress", body.toString());
            } catch (Exception error) {
                Log.w(LOG_TAG, "progress report failed: " + error.getMessage());
            }
        }).start();
    }

    private String formatTime(long milliseconds) {
        long totalSeconds = milliseconds / MILLISECONDS_PER_SECOND;
        long hours = totalSeconds / 3600;
        long minutes = (totalSeconds % 3600) / 60;
        long seconds = totalSeconds % 60;
        if (hours > 0) {
            return String.format("%d:%02d:%02d", hours, minutes, seconds);
        }
        return String.format("%d:%02d", minutes, seconds);
    }

    private void showNotice(String text) {
        noticeView.setText(text);
        noticeView.setVisibility(TextView.VISIBLE);
        handler.removeCallbacks(noticeHider);
        handler.postDelayed(noticeHider, NOTICE_DURATION_MILLISECONDS);
    }

    private final Runnable noticeHider = () -> noticeView.setVisibility(TextView.GONE);

    @Override
    protected void onStop() {
        reportProgress();
        super.onStop();
    }

    private void releasePlayer() {
        handler.removeCallbacks(progressReporter);
        if (subtitleController != null) {
            subtitleController.stop();
            subtitleController = null;
        }
        if (player != null) {
            player.release();
            player = null;
        }
    }

    @Override
    protected void onDestroy() {
        if (liveInstance == this) {
            liveInstance = null;
        }
        handler.removeCallbacksAndMessages(null);
        releasePlayer();
        super.onDestroy();
    }

    private static PlayerActivity liveInstance;

    public static boolean applyMeasuredOffset(String contentKey, long offsetMilliseconds) {
        final PlayerActivity target = liveInstance;
        if (target == null || contentKey == null || contentKey.equals(target.contentKey) == false) {
            return false;
        }
        target.handler.post(() -> {
            if (target.subtitleController != null) {
                target.subtitleController.setOffsetMilliseconds(offsetMilliseconds);
                double seconds = offsetMilliseconds / (double) MILLISECONDS_PER_SECOND;
                target.showNotice(String.format("Subtitles auto-aligned %+.1f s", seconds));
            }
        });
        return true;
    }

    public static Intent buildIntent(Context context, String playbackJson) {
        Intent intent = new Intent(context, PlayerActivity.class);
        intent.putExtra(EXTRA_PLAYBACK, playbackJson);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return intent;
    }
}
