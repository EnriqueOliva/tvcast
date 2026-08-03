package com.enrique.capytv;

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
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionParameters;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.MergingMediaSource;
import androidx.media3.ui.PlayerView;
import androidx.media3.ui.SubtitleView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

public class PlayerActivity extends Activity {

    public static final String EXTRA_PLAYBACK = "playback";

    private static final String LOG_TAG = "capytv";
    private static final int SEEK_BACK_MILLISECONDS = 10000;
    private static final int SEEK_FORWARD_MILLISECONDS = 30000;
    private static final int SUBTITLE_STEP_MILLISECONDS = 100;
    private static final int PROGRESS_INTERVAL_MILLISECONDS = 10000;
    private static final int PROGRESS_SETTLE_MILLISECONDS = 400;
    private static final int NOTICE_DURATION_MILLISECONDS = 3500;
    private static final int SUBTITLE_PILL_DURATION_MILLISECONDS = 4000;
    private static final int MILLISECONDS_PER_SECOND = 1000;
    private static final int BUFFER_MINIMUM_MILLISECONDS = 20000;
    private static final int BUFFER_MAXIMUM_MILLISECONDS = 60000;
    private static final int BUFFER_FOR_PLAYBACK_MILLISECONDS = 2000;
    private static final int BUFFER_AFTER_REBUFFER_MILLISECONDS = 5000;
    private static final int SUBTITLE_OFF_INDEX = -1;
    private static final int CONTROLLER_TIMEOUT_MILLISECONDS = 4000;
    private static final String EMPTY_STRING = "";
    private static final String SEPARATOR = "  ·  ";
    private static final String MEDIA_KIND_HLS = "hls";
    private static final String MEDIA_KIND_SPLIT = "split";
    private static final float VOLUME_STEP = 0.05f;
    private static final float FULL_VOLUME = 1f;
    private static final float NO_VOLUME = 0f;
    private static final int PERCENT = 100;
    private static final String PREFERENCES_NAME = "capytv";
    private static final String VOLUME_KEY = "playerVolume";
    private static final int[] HEIGHT_LADDER = { 1080, 720, 480, 360 };
    private static final int FIRST_INDEX = 0;
    private static final int PANEL_WIDTH = 580;
    private static final int PANEL_TEXT_SIZE = 19;
    private static final int PANEL_HEADING_TEXT_SIZE = 13;
    private static final int NOTICE_TEXT_SIZE = 19;
    private static final int HINT_TEXT_SIZE = 15;
    private static final int PILL_TEXT_SIZE = 15;
    private static final int STAGE_HEADLINE_TEXT_SIZE = 30;
    private static final int STAGE_TITLE_TEXT_SIZE = 21;
    private static final int STAGE_META_TEXT_SIZE = 15;
    private static final int STAGE_DETAIL_TEXT_SIZE = 16;
    private static final int SPINNER_SIZE = 66;
    private static final int PILL_SPINNER_SIZE = 26;

    private static final String STAGE_LOADING_VIDEO = "Loading video";
    private static final String STAGE_BUFFERING = "Buffering";
    private static final String STAGE_PLAYBACK_FAILED = "Cannot play this";

    // Stable handles for anything a test or a screen reader needs to find by name rather than
    // by guessing at its position on screen.
    private static final String DESCRIPTION_STAGE_HEADLINE = "capytv-stage-headline";
    private static final String DESCRIPTION_STAGE_TITLE = "capytv-stage-title";
    private static final String DESCRIPTION_STAGE_META = "capytv-stage-meta";
    private static final String DESCRIPTION_STAGE_DETAIL = "capytv-stage-detail";
    private static final String DESCRIPTION_SUBTITLE_PILL = "capytv-subtitle-pill";
    private static final String DESCRIPTION_BUFFERING_PILL = "capytv-buffering-pill";
    private static final String DESCRIPTION_NOTICE = "capytv-notice";
    private static final String DESCRIPTION_PANEL_ROW = "capytv-panel-row";

    private final Handler handler = new Handler(Looper.getMainLooper());

    private ExoPlayer player;
    private PlayerView playerView;
    private SubtitleView subtitleView;
    private TextView noticeView;
    private TextView hintView;
    private ScrollView settingsPanel;
    private LinearLayout settingsRows;
    private SubtitleController subtitleController;

    private View stageOverlay;
    private ProgressBar stageSpinner;
    private TextView stageHeadlineView;
    private TextView stageTitleView;
    private TextView stageMetaView;
    private TextView stageDetailView;

    private LinearLayout pillColumn;
    private LinearLayout bufferingPill;
    private LinearLayout subtitlePill;
    private TextView subtitlePillText;
    private ProgressBar subtitlePillSpinner;

    private JSONObject playback;
    private JSONArray subtitleTracks;
    private int selectedSubtitleIndex = SUBTITLE_OFF_INDEX;
    private int heightLadderIndex = FIRST_INDEX;
    private String contentKey = EMPTY_STRING;
    private String serverBaseUrl = EMPTY_STRING;
    private float volumeBeforeMute = FULL_VOLUME;
    private boolean firstFrameRendered = false;

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
        discardCurrentItem();
        applyPlayback(intent);
    }

    private void discardCurrentItem() {
        reportProgress();
        releasePlayer();
        closeSettingsPanel();
        subtitleView.setCues(null);
        noticeView.setVisibility(View.GONE);
        hideSubtitlePill();
        showBufferingPill(false);
        playback = null;
        subtitleTracks = new JSONArray();
        selectedSubtitleIndex = SUBTITLE_OFF_INDEX;
        heightLadderIndex = FIRST_INDEX;
        contentKey = EMPTY_STRING;
        firstFrameRendered = false;
        Log.i(LOG_TAG, "discarded the previous item before loading the new one");
    }

    private void buildLayout() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        playerView = new PlayerView(this);
        playerView.setUseController(true);
        playerView.setShowSubtitleButton(false);
        playerView.setControllerShowTimeoutMs(CONTROLLER_TIMEOUT_MILLISECONDS);
        root.addView(playerView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        subtitleView = new SubtitleView(this);
        root.addView(subtitleView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        root.addView(buildStageOverlay(), new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        pillColumn = new LinearLayout(this);
        pillColumn.setOrientation(LinearLayout.VERTICAL);
        bufferingPill = buildPill(STAGE_BUFFERING, Theme.INFO, DESCRIPTION_BUFFERING_PILL);
        subtitlePill = buildPill(EMPTY_STRING, Theme.ACCENT, DESCRIPTION_SUBTITLE_PILL);
        pillColumn.addView(bufferingPill);
        pillColumn.addView(subtitlePill);
        FrameLayout.LayoutParams pillLayout = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        pillLayout.gravity = Gravity.TOP | Gravity.START;
        pillLayout.topMargin = 48;
        pillLayout.leftMargin = 56;
        root.addView(pillColumn, pillLayout);

        noticeView = Theme.label(this, EMPTY_STRING, NOTICE_TEXT_SIZE, Theme.TEXT);
        noticeView.setContentDescription(DESCRIPTION_NOTICE);
        noticeView.setBackground(Theme.box(Theme.PANEL_BACKGROUND, Theme.LINE,
                Theme.STROKE_WIDTH, Theme.PILL_RADIUS));
        noticeView.setPadding(34, 18, 34, 20);
        noticeView.setVisibility(View.GONE);
        FrameLayout.LayoutParams noticeLayout = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        noticeLayout.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        noticeLayout.topMargin = 48;
        root.addView(noticeView, noticeLayout);

        hintView = Theme.label(this, "☰  subtitles & volume", HINT_TEXT_SIZE, Theme.TEXT_SECONDARY);
        hintView.setBackground(Theme.box(Theme.CHIP_BACKGROUND, Theme.LINE,
                Theme.STROKE_WIDTH, Theme.PILL_RADIUS));
        hintView.setPadding(26, 14, 26, 16);
        hintView.setVisibility(View.GONE);
        FrameLayout.LayoutParams hintLayout = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hintLayout.gravity = Gravity.TOP | Gravity.END;
        hintLayout.topMargin = 48;
        hintLayout.rightMargin = 56;
        root.addView(hintView, hintLayout);

        settingsRows = new LinearLayout(this);
        settingsRows.setOrientation(LinearLayout.VERTICAL);
        settingsRows.setPadding(30, 34, 30, 34);
        settingsPanel = new ScrollView(this);
        settingsPanel.setBackgroundColor(Theme.PANEL_BACKGROUND);
        settingsPanel.setVerticalScrollBarEnabled(false);
        settingsPanel.setVisibility(View.GONE);
        settingsPanel.addView(settingsRows, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        FrameLayout.LayoutParams panelLayout = new FrameLayout.LayoutParams(
                PANEL_WIDTH, ViewGroup.LayoutParams.MATCH_PARENT);
        panelLayout.gravity = Gravity.END;
        root.addView(settingsPanel, panelLayout);

        playerView.setControllerVisibilityListener((PlayerView.ControllerVisibilityListener) visibility ->
                hintView.setVisibility(
                        visibility == View.VISIBLE && settingsPanel.getVisibility() != View.VISIBLE
                                && stageOverlay.getVisibility() != View.VISIBLE
                                ? View.VISIBLE : View.GONE));

        setContentView(root);
    }

    private View buildStageOverlay() {
        LinearLayout centred = new LinearLayout(this);
        centred.setOrientation(LinearLayout.VERTICAL);
        centred.setGravity(Gravity.CENTER);
        centred.setBackgroundColor(Theme.SCRIM);
        centred.setPadding(120, 0, 120, 0);

        stageSpinner = Theme.spinner(this, Theme.ACCENT);
        LinearLayout.LayoutParams spinnerLayout =
                new LinearLayout.LayoutParams(SPINNER_SIZE, SPINNER_SIZE);
        spinnerLayout.gravity = Gravity.CENTER_HORIZONTAL;
        spinnerLayout.bottomMargin = 40;
        centred.addView(stageSpinner, spinnerLayout);

        stageHeadlineView = Theme.label(this, STAGE_LOADING_VIDEO, STAGE_HEADLINE_TEXT_SIZE, Theme.TEXT);
        stageHeadlineView.setGravity(Gravity.CENTER_HORIZONTAL);
        stageHeadlineView.setContentDescription(DESCRIPTION_STAGE_HEADLINE);
        centred.addView(stageHeadlineView);

        stageTitleView = Theme.label(this, EMPTY_STRING, STAGE_TITLE_TEXT_SIZE, Theme.TEXT_SECONDARY);
        stageTitleView.setGravity(Gravity.CENTER_HORIZONTAL);
        stageTitleView.setContentDescription(DESCRIPTION_STAGE_TITLE);
        stageTitleView.setPadding(0, 20, 0, 0);
        centred.addView(stageTitleView);

        stageMetaView = Theme.kicker(this, EMPTY_STRING);
        stageMetaView.setTextSize(STAGE_META_TEXT_SIZE);
        stageMetaView.setContentDescription(DESCRIPTION_STAGE_META);
        stageMetaView.setGravity(Gravity.CENTER_HORIZONTAL);
        stageMetaView.setPadding(0, 14, 0, 0);
        centred.addView(stageMetaView);

        stageDetailView = Theme.label(this, EMPTY_STRING, STAGE_DETAIL_TEXT_SIZE, Theme.INFO);
        stageDetailView.setGravity(Gravity.CENTER_HORIZONTAL);
        stageDetailView.setContentDescription(DESCRIPTION_STAGE_DETAIL);
        stageDetailView.setPadding(0, 30, 0, 0);
        centred.addView(stageDetailView);

        stageOverlay = centred;
        stageOverlay.setVisibility(View.GONE);
        return stageOverlay;
    }

    private LinearLayout buildPill(String text, int tone, String description) {
        LinearLayout pill = new LinearLayout(this);
        pill.setOrientation(LinearLayout.HORIZONTAL);
        pill.setGravity(Gravity.CENTER_VERTICAL);
        pill.setBackground(Theme.box(Theme.CHIP_BACKGROUND, Theme.LINE,
                Theme.STROKE_WIDTH, Theme.PILL_RADIUS));
        pill.setPadding(24, 14, 30, 16);
        pill.setVisibility(View.GONE);

        ProgressBar spinner = Theme.spinner(this, tone);
        LinearLayout.LayoutParams spinnerLayout =
                new LinearLayout.LayoutParams(PILL_SPINNER_SIZE, PILL_SPINNER_SIZE);
        spinnerLayout.rightMargin = 18;
        pill.addView(spinner, spinnerLayout);

        TextView caption = Theme.label(this, text, PILL_TEXT_SIZE, Theme.TEXT);
        caption.setContentDescription(description);
        pill.addView(caption);

        LinearLayout.LayoutParams pillLayout = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        pillLayout.bottomMargin = 14;
        pill.setLayoutParams(pillLayout);
        pill.setTag(new View[] { spinner, caption });
        return pill;
    }

    private void setPillText(LinearLayout pill, String text) {
        View[] parts = (View[]) pill.getTag();
        ((TextView) parts[1]).setText(text);
    }

    private void setPillBusy(LinearLayout pill, boolean busy) {
        View[] parts = (View[]) pill.getTag();
        parts[FIRST_INDEX].setVisibility(busy ? View.VISIBLE : View.GONE);
    }

    private void showStage(String headline, String detail) {
        stageHeadlineView.setText(headline);
        stageDetailView.setText(detail);
        stageDetailView.setVisibility(detail.length() == 0 ? View.GONE : View.VISIBLE);
        stageTitleView.setText(describeTitle());
        stageTitleView.setVisibility(describeTitle().length() == 0 ? View.GONE : View.VISIBLE);
        stageMetaView.setText(describeMedia());
        stageMetaView.setVisibility(describeMedia().length() == 0 ? View.GONE : View.VISIBLE);
        stageOverlay.setVisibility(View.VISIBLE);
        hintView.setVisibility(View.GONE);
        // The transport controls sit under this overlay and show through it. There is nothing
        // to scrub yet anyway, so take them away until the first frame arrives.
        playerView.hideController();
        playerView.setUseController(false);
    }

    private void setStageDetail(String detail) {
        if (stageOverlay.getVisibility() == View.VISIBLE) {
            stageDetailView.setText(detail);
            stageDetailView.setVisibility(detail.length() == 0 ? View.GONE : View.VISIBLE);
        }
    }

    private void setStageFailed(String headline, String detail) {
        showStage(headline, detail);
        stageSpinner.setVisibility(View.GONE);
        stageHeadlineView.setTextColor(Theme.BAD);
        stageDetailView.setTextColor(Theme.TEXT_SECONDARY);
    }

    private void setStageBusy(String headline, String detail) {
        showStage(headline, detail);
        stageSpinner.setVisibility(View.VISIBLE);
        stageHeadlineView.setTextColor(Theme.TEXT);
        stageDetailView.setTextColor(Theme.INFO);
    }

    private void hideStage() {
        stageOverlay.setVisibility(View.GONE);
        playerView.setUseController(true);
    }

    private void showBufferingPill(boolean visible) {
        bufferingPill.setVisibility(visible ? View.VISIBLE : View.GONE);
    }

    private void showSubtitlePill(String text, boolean busy) {
        setPillText(subtitlePill, text);
        setPillBusy(subtitlePill, busy);
        subtitlePill.setVisibility(View.VISIBLE);
        handler.removeCallbacks(subtitlePillHider);
        if (busy == false) {
            handler.postDelayed(subtitlePillHider, SUBTITLE_PILL_DURATION_MILLISECONDS);
        }
    }

    private void hideSubtitlePill() {
        handler.removeCallbacks(subtitlePillHider);
        subtitlePill.setVisibility(View.GONE);
    }

    private final Runnable subtitlePillHider = () -> subtitlePill.setVisibility(View.GONE);

    private String describeTitle() {
        if (playback == null) {
            return EMPTY_STRING;
        }
        return playback.optString("title", EMPTY_STRING);
    }

    // Where it is picking up from belongs here rather than on the detail line, which the
    // buffering and ready states overwrite within milliseconds of the screen appearing.
    private String describeMedia() {
        if (playback == null) {
            return EMPTY_STRING;
        }
        StringBuilder described = new StringBuilder();
        String quality = playback.optString("quality", EMPTY_STRING);
        String provider = playback.optString("provider", EMPTY_STRING);
        long resumeMilliseconds = playback.optLong("resumeMilliseconds", 0);
        if (quality.length() > 0) {
            described.append(quality);
        }
        if (provider.length() > 0) {
            if (described.length() > 0) {
                described.append(SEPARATOR);
            }
            described.append(provider);
        }
        if (resumeMilliseconds > 0) {
            if (described.length() > 0) {
                described.append(SEPARATOR);
            }
            described.append("resuming at ").append(formatTime(resumeMilliseconds));
        }
        return described.toString();
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
        heightLadderIndex = FIRST_INDEX;
        firstFrameRendered = false;
        Log.i(LOG_TAG, "loading " + playback.optString("title") + " contentKey=" + contentKey
                + " subtitleTracks=" + subtitleTracks.length());
        setStageBusy(STAGE_LOADING_VIDEO, "opening the stream");
        startPlayer();
    }

    private int currentHeightCeiling() {
        return HEIGHT_LADDER[heightLadderIndex];
    }

    private void applyTrackSelection() {
        TrackSelectionParameters.Builder selection = player.getTrackSelectionParameters().buildUpon()
                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
                .setMaxVideoSize(Integer.MAX_VALUE, currentHeightCeiling())
                .setForceHighestSupportedBitrate(true);
        player.setTrackSelectionParameters(selection.build());
        Log.i(LOG_TAG, "video capped at " + currentHeightCeiling() + "p");
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
        applyTrackSelection();

        volumeBeforeMute = readStoredVolume();
        player.setVolume(volumeBeforeMute);

        subtitleController = new SubtitleController(subtitleView, player);

        player.addListener(new Player.Listener() {
            @Override
            public void onPlayerError(PlaybackException error) {
                Log.e(LOG_TAG, "playback error " + error.getErrorCodeName(), error);
                stepDownQuality(error);
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_ENDED) {
                    reportProgress();
                    finish();
                } else if (state == Player.STATE_BUFFERING) {
                    if (firstFrameRendered) {
                        showBufferingPill(true);
                    } else {
                        setStageBusy(STAGE_LOADING_VIDEO, "buffering the stream");
                    }
                } else if (state == Player.STATE_READY) {
                    showBufferingPill(false);
                    setStageDetail("starting playback");
                }
            }

            @Override
            public void onRenderedFirstFrame() {
                firstFrameRendered = true;
                showBufferingPill(false);
                hideStage();
                Log.i(LOG_TAG, "first frame rendered, the loading screen is gone");
            }
        });

        player.setMediaSource(buildMediaSource());
        player.prepare();

        long resumeMilliseconds = playback.optLong("resumeMilliseconds", 0);
        if (resumeMilliseconds > 0) {
            player.seekTo(resumeMilliseconds);
            setStageBusy(STAGE_LOADING_VIDEO, "resuming at " + formatTime(resumeMilliseconds));
        }
        player.setPlayWhenReady(true);
        playerView.requestFocus();

        subtitleController.setOffsetMilliseconds(playback.optLong("subtitleOffsetMilliseconds", 0));
        subtitleController.start();
        selectInitialSubtitle();
        handler.postDelayed(progressReporter, PROGRESS_INTERVAL_MILLISECONDS);
    }

    private void stepDownQuality(PlaybackException error) {
        if (heightLadderIndex + 1 >= HEIGHT_LADDER.length) {
            setStageFailed(STAGE_PLAYBACK_FAILED, error.getErrorCodeName());
            showNotice("Playback failed: " + error.getErrorCodeName());
            return;
        }
        long position = player.getCurrentPosition();
        heightLadderIndex += 1;
        applyTrackSelection();
        player.setMediaSource(buildMediaSource());
        player.prepare();
        if (position > 0) {
            player.seekTo(position);
        }
        player.setPlayWhenReady(true);
        firstFrameRendered = false;
        setStageBusy(STAGE_LOADING_VIDEO, "retrying at " + currentHeightCeiling() + "p");
        showNotice("Retrying at " + currentHeightCeiling() + "p");
        Log.i(LOG_TAG, "stepped quality down to " + currentHeightCeiling() + "p after "
                + error.getErrorCodeName());
    }

    private DefaultMediaSourceFactory buildSourceFactory() {
        DefaultHttpDataSource.Factory httpFactory = new DefaultHttpDataSource.Factory()
                .setAllowCrossProtocolRedirects(true);
        JSONObject headers = playback.optJSONObject("httpHeaders");
        if (headers != null && headers.length() > 0) {
            Map<String, String> requestProperties = new HashMap<>();
            Iterator<String> names = headers.keys();
            while (names.hasNext()) {
                String name = names.next();
                requestProperties.put(name, headers.optString(name));
            }
            httpFactory.setDefaultRequestProperties(requestProperties);
        }
        return new DefaultMediaSourceFactory(httpFactory);
    }

    private MediaSource buildMediaSource() {
        DefaultMediaSourceFactory sourceFactory = buildSourceFactory();
        String mediaKind = playback.optString("mediaKind", MEDIA_KIND_HLS);
        String mediaUrl = playback.optString("mediaUrl");
        String audioUrl = playback.optString("audioUrl", EMPTY_STRING);

        if (mediaKind.equals(MEDIA_KIND_SPLIT) && audioUrl.length() > 0) {
            MediaSource videoSource = sourceFactory.createMediaSource(MediaItem.fromUri(mediaUrl));
            MediaSource audioSource = sourceFactory.createMediaSource(MediaItem.fromUri(audioUrl));
            Log.i(LOG_TAG, "merging separate video and audio streams");
            return new MergingMediaSource(videoSource, audioSource);
        }

        MediaItem.Builder itemBuilder = new MediaItem.Builder().setUri(mediaUrl);
        if (mediaKind.equals(MEDIA_KIND_HLS)) {
            itemBuilder.setMimeType(MimeTypes.APPLICATION_M3U8);
        }
        return sourceFactory.createMediaSource(itemBuilder.build());
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
        announceMissingSubtitles();
    }

    // Playing on in silence after every subtitle track refused to load looks like the app
    // simply forgot about subtitles. Say what happened instead.
    private void announceMissingSubtitles() {
        String warning = playback.optString("subtitleWarning", EMPTY_STRING);
        if (warning.length() > 0) {
            showSubtitlePill("Subtitles unavailable for this stream", false);
        } else if (subtitleTracks.length() == 0) {
            showSubtitlePill("No subtitles offered for this", false);
        }
    }

    private void loadSubtitle(final int index, final boolean announce) {
        if (index == SUBTITLE_OFF_INDEX) {
            selectedSubtitleIndex = SUBTITLE_OFF_INDEX;
            subtitleController.setCueTrack(CueTrack.empty());
            hideSubtitlePill();
            if (announce) {
                showNotice("Subtitles off");
            }
            reportProgressSoon();
            return;
        }
        final JSONObject track = subtitleTracks.optJSONObject(index);
        if (track == null) {
            return;
        }
        selectedSubtitleIndex = index;
        final String cuesUrl = track.optString("cuesUrl");
        final String language = track.optString("language");
        showSubtitlePill("Loading " + language + " subtitles", true);
        new Thread(() -> {
            try {
                final String body = ServerApi.get(cuesUrl);
                final CueTrack parsed = CueTrack.parse(body);
                handler.post(() -> {
                    subtitleController.setCueTrack(parsed);
                    showSubtitlePill(language + SEPARATOR + parsed.size() + " lines", false);
                    showNotice("Subtitles: " + language + " (" + parsed.size() + " lines)");
                    Log.i(LOG_TAG, "loaded " + parsed.size() + " cues for " + language);
                    reportProgressSoon();
                });
            } catch (Exception error) {
                Log.e(LOG_TAG, "subtitle load failed", error);
                handler.post(() -> {
                    showSubtitlePill("No " + language + " subtitles", false);
                    showNotice("Could not load " + language + " subtitles");
                });
            }
        }).start();
    }

    private void nudgeSubtitle(int deltaMilliseconds) {
        if (subtitleController.hasCues() == false) {
            showNotice("No subtitles to shift");
            return;
        }
        long updated = subtitleController.getOffsetMilliseconds() + deltaMilliseconds;
        subtitleController.setOffsetMilliseconds(updated);
        showNotice(describeSubtitleOffset(updated));
        reportProgressSoon();
    }

    private String describeSubtitleOffset(long offsetMilliseconds) {
        double seconds = Math.abs(offsetMilliseconds) / (double) MILLISECONDS_PER_SECOND;
        if (offsetMilliseconds == 0) {
            return "Subtitles in step with the audio";
        } else if (offsetMilliseconds > 0) {
            return String.format("Subtitles %.1f s later", seconds);
        } else {
            return String.format("Subtitles %.1f s earlier", seconds);
        }
    }

    private boolean isSettingsPanelOpen() {
        return settingsPanel.getVisibility() == View.VISIBLE;
    }

    private void openSettingsPanel() {
        settingsRows.removeAllViews();
        settingsRows.addView(buildPanelHeading("subtitles"));
        settingsRows.addView(buildPanelRow("Off", selectedSubtitleIndex == SUBTITLE_OFF_INDEX,
                view -> {
                    loadSubtitle(SUBTITLE_OFF_INDEX, true);
                    closeSettingsPanel();
                }));
        for (int index = 0; index < subtitleTracks.length(); index += 1) {
            final int trackIndex = index;
            JSONObject track = subtitleTracks.optJSONObject(index);
            String language = track == null ? EMPTY_STRING : track.optString("language", "Subtitles");
            settingsRows.addView(buildPanelRow(language, selectedSubtitleIndex == trackIndex,
                    view -> {
                        loadSubtitle(trackIndex, true);
                        closeSettingsPanel();
                    }));
        }
        settingsRows.addView(buildPanelHeading("volume  ·  " + describeVolume()));
        settingsRows.addView(buildPanelRow("Volume down", false, view -> changeVolume(-VOLUME_STEP)));
        settingsRows.addView(buildPanelRow("Volume up", false, view -> changeVolume(VOLUME_STEP)));
        settingsRows.addView(buildPanelRow("Mute or unmute", false, view -> toggleMute()));

        playerView.hideController();
        hintView.setVisibility(View.GONE);
        settingsPanel.setVisibility(View.VISIBLE);
        if (settingsRows.getChildCount() > 1) {
            settingsRows.getChildAt(1).requestFocus();
        }
    }

    private void closeSettingsPanel() {
        settingsPanel.setVisibility(View.GONE);
        settingsRows.removeAllViews();
        playerView.requestFocus();
    }

    private String describeVolume() {
        float level = player == null ? FULL_VOLUME : player.getVolume();
        return Math.round(level * PERCENT) + "%";
    }

    private TextView buildPanelHeading(String text) {
        TextView heading = Theme.kicker(this, text);
        heading.setTextSize(PANEL_HEADING_TEXT_SIZE);
        heading.setPadding(14, 30, 14, 14);
        return heading;
    }

    private Button buildPanelRow(String label, boolean isSelected, View.OnClickListener onSelect) {
        Button row = new Button(this);
        row.setContentDescription(DESCRIPTION_PANEL_ROW);
        row.setText(isSelected ? "•  " + label : "    " + label);
        row.setTextSize(PANEL_TEXT_SIZE);
        row.setTextColor(isSelected ? Theme.ACCENT : Theme.TEXT);
        row.setAllCaps(false);
        row.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        row.setPadding(26, 22, 26, 24);
        row.setBackground(Theme.card(false));
        row.setStateListAnimator(null);
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        layout.bottomMargin = 10;
        row.setLayoutParams(layout);
        row.setOnFocusChangeListener((view, focused) -> {
            view.setBackground(Theme.card(focused));
            ((Button) view).setTextColor(focused ? Theme.TEXT : (isSelected ? Theme.ACCENT : Theme.TEXT));
        });
        row.setOnClickListener(onSelect);
        return row;
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() != KeyEvent.ACTION_DOWN || player == null) {
            return super.dispatchKeyEvent(event);
        }
        int code = event.getKeyCode();
        Log.i(LOG_TAG, "key " + code + " " + KeyEvent.keyCodeToString(code));

        if (isSettingsPanelOpen()) {
            if (code == KeyEvent.KEYCODE_BACK || code == KeyEvent.KEYCODE_MENU) {
                closeSettingsPanel();
                return true;
            }
            return super.dispatchKeyEvent(event);
        }


        if (code == KeyEvent.KEYCODE_BACK) {
            reportProgress();
            finish();
            return true;
        } else if (code == KeyEvent.KEYCODE_MENU || code == KeyEvent.KEYCODE_CAPTIONS
                || code == KeyEvent.KEYCODE_SETTINGS || code == KeyEvent.KEYCODE_INFO) {
            openSettingsPanel();
            return true;
        } else if (code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || code == KeyEvent.KEYCODE_MEDIA_PLAY
                || code == KeyEvent.KEYCODE_MEDIA_PAUSE) {
            togglePlayback();
            reportProgressSoon();
            return true;
        } else if (code == KeyEvent.KEYCODE_MEDIA_REWIND) {
            player.seekBack();
            reportProgressSoon();
            return true;
        } else if (code == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD) {
            player.seekForward();
            reportProgressSoon();
            return true;
        } else if (code == KeyEvent.KEYCODE_DPAD_LEFT) {
            player.seekBack();
            showNotice("-10 s");
            reportProgressSoon();
            return true;
        } else if (code == KeyEvent.KEYCODE_DPAD_RIGHT) {
            player.seekForward();
            showNotice("+30 s");
            reportProgressSoon();
            return true;
        } else if (code == KeyEvent.KEYCODE_VOLUME_UP) {
            changeVolume(VOLUME_STEP);
            return true;
        } else if (code == KeyEvent.KEYCODE_VOLUME_DOWN) {
            changeVolume(-VOLUME_STEP);
            return true;
        } else if (code == KeyEvent.KEYCODE_VOLUME_MUTE) {
            toggleMute();
            return true;
        } else if (code == KeyEvent.KEYCODE_DPAD_UP) {
            nudgeSubtitle(SUBTITLE_STEP_MILLISECONDS);
            return true;
        } else if (code == KeyEvent.KEYCODE_DPAD_DOWN) {
            nudgeSubtitle(-SUBTITLE_STEP_MILLISECONDS);
            return true;
        } else {
            return super.dispatchKeyEvent(event);
        }
    }

    private void changeVolume(float delta) {
        float updated = Math.max(NO_VOLUME, Math.min(FULL_VOLUME, player.getVolume() + delta));
        player.setVolume(updated);
        Log.i(LOG_TAG, "volume " + player.getVolume());
        volumeBeforeMute = updated > NO_VOLUME ? updated : volumeBeforeMute;
        showNotice("Volume " + Math.round(updated * PERCENT) + "%");
        storeVolume(updated);
    }

    private void toggleMute() {
        if (player.getVolume() > NO_VOLUME) {
            volumeBeforeMute = player.getVolume();
            player.setVolume(NO_VOLUME);
            showNotice("Muted");
        } else {
            player.setVolume(volumeBeforeMute);
            showNotice("Volume " + Math.round(volumeBeforeMute * PERCENT) + "%");
        }
    }

    private void storeVolume(float level) {
        getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE)
                .edit().putFloat(VOLUME_KEY, level).apply();
    }

    private float readStoredVolume() {
        return getSharedPreferences(PREFERENCES_NAME, MODE_PRIVATE).getFloat(VOLUME_KEY, FULL_VOLUME);
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

    private final Runnable settledProgressReporter = this::reportProgress;

    // Waiting for the next ten second tick after a seek means the pc's idea of where you are
    // can be half a minute stale, which is exactly what it resumes from if the stick loses
    // power. Report once the presses stop instead.
    private void reportProgressSoon() {
        handler.removeCallbacks(settledProgressReporter);
        handler.postDelayed(settledProgressReporter, PROGRESS_SETTLE_MILLISECONDS);
    }

    private void reportProgress() {
        if (player == null || contentKey.length() == 0 || serverBaseUrl.length() == 0) {
            return;
        }
        final long position = player.getCurrentPosition();
        final long duration = player.getDuration();
        final long offset = subtitleController == null ? 0 : subtitleController.getOffsetMilliseconds();
        final String subtitleId = selectedSubtitleIndex == SUBTITLE_OFF_INDEX
                ? EMPTY_STRING
                : subtitleTracks.optJSONObject(selectedSubtitleIndex).optString("id");
        Log.i(LOG_TAG, "position=" + position + " duration=" + duration
                + " playing=" + player.isPlaying()
                + " subtitle=" + subtitleId + " offset=" + offset);
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
        Log.i(LOG_TAG, "notice " + text);
        noticeView.setText(text);
        noticeView.setVisibility(View.VISIBLE);
        handler.removeCallbacks(noticeHider);
        handler.postDelayed(noticeHider, NOTICE_DURATION_MILLISECONDS);
    }

    private final Runnable noticeHider = () -> noticeView.setVisibility(View.GONE);

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
                target.showNotice("Auto-aligned: " + target.describeSubtitleOffset(offsetMilliseconds));
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
