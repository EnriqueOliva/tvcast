package com.enrique.tvcast;

import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;

import androidx.media3.common.Player;
import androidx.media3.common.text.Cue;
import androidx.media3.ui.CaptionStyleCompat;
import androidx.media3.ui.SubtitleView;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class SubtitleController {

    private static final int TICK_INTERVAL_MILLISECONDS = 100;
    private static final float TEXT_SIZE_FRACTION = 0.055f;
    private static final float BOTTOM_PADDING_FRACTION = 0.08f;
    private static final int SHADED_BACKGROUND = 0xB3000000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final SubtitleView subtitleView;
    private final Player player;

    private CueTrack cueTrack = CueTrack.empty();
    private long offsetMilliseconds;
    private boolean backgroundBoxEnabled;
    private boolean running;
    private List<String> lastRendered = Collections.emptyList();

    public SubtitleController(SubtitleView subtitleView, Player player) {
        this.subtitleView = subtitleView;
        this.player = player;
        applyAppearance();
    }

    private void applyAppearance() {
        subtitleView.setApplyEmbeddedStyles(false);
        subtitleView.setApplyEmbeddedFontSizes(false);
        subtitleView.setStyle(new CaptionStyleCompat(
                Color.WHITE,
                backgroundBoxEnabled ? SHADED_BACKGROUND : Color.TRANSPARENT,
                Color.TRANSPARENT,
                CaptionStyleCompat.EDGE_TYPE_OUTLINE,
                Color.BLACK,
                null));
        subtitleView.setFractionalTextSize(TEXT_SIZE_FRACTION);
        subtitleView.setBottomPaddingFraction(BOTTOM_PADDING_FRACTION);
    }

    public void setCueTrack(CueTrack track) {
        cueTrack = track == null ? CueTrack.empty() : track;
        lastRendered = Collections.emptyList();
        render(true);
    }

    public void setOffsetMilliseconds(long value) {
        offsetMilliseconds = value;
        render(true);
    }

    public long getOffsetMilliseconds() {
        return offsetMilliseconds;
    }

    public void toggleBackgroundBox() {
        backgroundBoxEnabled = backgroundBoxEnabled == false;
        applyAppearance();
    }

    public boolean hasCues() {
        return cueTrack.size() > 0;
    }

    public void start() {
        if (running) {
            return;
        }
        running = true;
        handler.post(tick);
    }

    public void stop() {
        running = false;
        handler.removeCallbacks(tick);
    }

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (running == false) {
                return;
            }
            render(false);
            handler.postDelayed(this, TICK_INTERVAL_MILLISECONDS);
        }
    };

    private void render(boolean force) {
        long lookup = player.getCurrentPosition() + offsetMilliseconds;
        List<String> active = cueTrack.textAt(lookup);
        if (force == false && active.equals(lastRendered)) {
            return;
        }
        if (active.equals(lastRendered) == false && active.isEmpty() == false) {
            long cueStart = cueTrack.activeStartMilliseconds(lookup);
            android.util.Log.i("tvcast", "cuechange playerPosition=" + player.getCurrentPosition()
                    + " lookup=" + lookup + " cueStart=" + cueStart
                    + " lag=" + (cueStart < 0 ? 0 : lookup - cueStart));
        }
        lastRendered = active;
        List<Cue> cues = new ArrayList<Cue>(active.size());
        for (String text : active) {
            cues.add(new Cue.Builder().setText(text).build());
        }
        subtitleView.setCues(cues);
    }
}
