package com.enrique.capytv;

import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.ProgressBar;
import android.widget.TextView;

final class Theme {

    static final int BACKGROUND = 0xFF0A0C10;
    static final int BACKGROUND_LIFT = 0xFF10151C;
    static final int SURFACE = 0xFF161C24;
    static final int SURFACE_RAISED = 0xFF1E2833;
    static final int SURFACE_FOCUSED = 0xFF2A3949;
    static final int LINE = 0xFF27313D;
    static final int LINE_SOFT = 0xFF1C242E;

    static final int TEXT = 0xFFEDF1F6;
    static final int TEXT_SECONDARY = 0xFFA6B3C2;
    static final int TEXT_MUTED = 0xFF6F7E8F;

    static final int ACCENT = 0xFFFFB454;
    static final int ACCENT_INK = 0xFF2A1B04;
    static final int INFO = 0xFF5BC8FF;
    static final int GOOD = 0xFF4ADE80;
    static final int WARN = 0xFFFFC257;
    static final int BAD = 0xFFFF6B6B;

    static final int SCRIM = 0xFF070A0E;
    static final int PANEL_BACKGROUND = 0xF2101720;
    static final int CHIP_BACKGROUND = 0xCC121821;

    static final int CARD_RADIUS = 14;
    static final int PILL_RADIUS = 999;
    static final int RAIL_RADIUS = 4;
    static final int STROKE_WIDTH = 1;
    static final int FOCUS_STROKE_WIDTH = 2;

    static final float FOCUS_SCALE = 1.025f;
    static final float RESTING_SCALE = 1f;
    static final int FOCUS_ANIMATION_MILLISECONDS = 130;

    private Theme() {
    }

    static GradientDrawable box(int fillColour, int strokeColour, int strokeWidth, int cornerRadius) {
        GradientDrawable shape = new GradientDrawable();
        shape.setShape(GradientDrawable.RECTANGLE);
        shape.setColor(fillColour);
        shape.setCornerRadius(cornerRadius);
        if (strokeWidth > 0) {
            shape.setStroke(strokeWidth, strokeColour);
        }
        return shape;
    }

    static GradientDrawable card(boolean focused) {
        if (focused) {
            return box(SURFACE_FOCUSED, ACCENT, FOCUS_STROKE_WIDTH, CARD_RADIUS);
        }
        return box(SURFACE, LINE_SOFT, STROKE_WIDTH, CARD_RADIUS);
    }

    static GradientDrawable tab(boolean focused, boolean open) {
        if (focused) {
            return box(ACCENT, ACCENT, FOCUS_STROKE_WIDTH, PILL_RADIUS);
        } else if (open) {
            return box(SURFACE_RAISED, ACCENT, STROKE_WIDTH, PILL_RADIUS);
        } else {
            return box(SURFACE, LINE, STROKE_WIDTH, PILL_RADIUS);
        }
    }

    static void applyFocusLift(View view, boolean focused) {
        view.animate()
                .scaleX(focused ? FOCUS_SCALE : RESTING_SCALE)
                .scaleY(focused ? FOCUS_SCALE : RESTING_SCALE)
                .setDuration(FOCUS_ANIMATION_MILLISECONDS)
                .start();
    }

    static TextView label(Context context, String text, int textSize, int colour) {
        TextView view = new TextView(context);
        view.setText(text);
        view.setTextSize(textSize);
        view.setTextColor(colour);
        return view;
    }

    static TextView kicker(Context context, String text) {
        TextView view = label(context, text.toUpperCase(), 12, TEXT_MUTED);
        view.setLetterSpacing(0.16f);
        return view;
    }

    static TextView chip(Context context, String text, int textSize) {
        TextView view = label(context, text, textSize, TEXT);
        view.setBackground(box(CHIP_BACKGROUND, LINE, STROKE_WIDTH, PILL_RADIUS));
        view.setPadding(26, 12, 26, 12);
        view.setGravity(Gravity.CENTER_VERTICAL);
        return view;
    }

    static ProgressBar spinner(Context context, int colour) {
        ProgressBar bar = new ProgressBar(context);
        bar.setIndeterminate(true);
        bar.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(colour));
        return bar;
    }

    static ProgressBar rail(Context context, int colour) {
        ProgressBar bar = new ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setProgressTintList(android.content.res.ColorStateList.valueOf(colour));
        bar.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(colour));
        bar.setBackground(box(LINE_SOFT, Color.TRANSPARENT, 0, RAIL_RADIUS));
        return bar;
    }

    static int scaled(Context context, int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value,
                context.getResources().getDisplayMetrics()));
    }
}
