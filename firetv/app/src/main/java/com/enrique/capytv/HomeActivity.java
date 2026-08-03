package com.enrique.capytv;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.text.style.RelativeSizeSpan;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

public class HomeActivity extends Activity {

    public static final String EXTRA_PLAYBACK = "playback";

    private static final String LOG_TAG = "capytv";
    private static final String EMPTY_STRING = "";
    private static final String MAIN_COLLECTION = "main";
    private static final String DOWNLOADS_SECTION = "downloads";
    private static final String KIND_DOWNLOAD = "download";
    private static final String SEPARATOR = "  ·  ";

    // Stable handles for anything a test or a screen reader needs to find by name rather than
    // by guessing at its position on screen.
    private static final String DESCRIPTION_STATUS = "capytv-status";
    private static final String DESCRIPTION_SERVER = "capytv-server";
    private static final String DESCRIPTION_ACTIVITY_STAGE = "capytv-activity-stage";
    private static final String DESCRIPTION_ACTIVITY_DETAIL = "capytv-activity-detail";
    private static final String DESCRIPTION_TAB_PREFIX = "capytv-tab-";
    private static final String DESCRIPTION_ROW = "capytv-row";

    private static final int HEADING_TEXT_SIZE = 30;
    private static final int STATUS_TEXT_SIZE = 15;
    private static final int ROW_TEXT_SIZE = 19;
    private static final int TAB_TEXT_SIZE = 16;
    private static final int STRIP_STAGE_TEXT_SIZE = 17;
    private static final int STRIP_DETAIL_TEXT_SIZE = 14;
    private static final float DETAIL_RELATIVE_SIZE = 0.72f;

    private static final int ROW_BOTTOM_MARGIN = 14;
    private static final int TAB_RIGHT_MARGIN = 14;
    private static final int FIRST_INDEX = 0;
    private static final int NO_ITEMS = 0;
    private static final int INDETERMINATE_PERCENT = -1;
    private static final int RAIL_HEIGHT = 8;

    // Work can start on the pc without this screen asking for it, so the idle gap is what
    // bounds how long the television can be showing nothing while the pc is busy.
    private static final int ACTIVE_POLL_MILLISECONDS = 800;
    private static final int IDLE_POLL_MILLISECONDS = 1500;

    private final Handler handler = new Handler(Looper.getMainLooper());

    private LinearLayout tabContainer;
    private LinearLayout listContainer;
    private TextView statusView;
    private TextView serverPill;
    private LinearLayout activityStrip;
    private ProgressBar activitySpinner;
    private TextView activityStageView;
    private TextView activityDetailView;
    private ProgressBar activityRail;

    private String openSection = MAIN_COLLECTION;
    private String serverBaseUrl = EMPTY_STRING;
    private boolean screenIsLive = false;
    private boolean somethingIsRunning = false;

    public static Intent buildPlaybackIntent(Context context, String playbackJson) {
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
        screenIsLive = true;
        PlaybackBridgeService.ensureRunning(this);
        locateServer();
        handler.removeCallbacks(activityPoller);
        handler.post(activityPoller);
    }

    @Override
    protected void onPause() {
        screenIsLive = false;
        handler.removeCallbacks(activityPoller);
        super.onPause();
    }

    private void locateServer() {
        statusView.setText("Looking for the pc...");
        setServerPill("looking for the pc", Theme.WARN);
        ServerLocator.discover(this, new ServerLocator.DiscoveryListener() {
            @Override
            public void onServerFound(String baseUrl) {
                handler.post(() -> {
                    serverBaseUrl = baseUrl;
                    setServerPill(readableAddress(baseUrl), Theme.GOOD);
                    collectPendingPlayback();
                    reloadSections();
                });
            }

            @Override
            public void onServerMissing() {
                handler.post(() -> {
                    setServerPill("pc not found", Theme.BAD);
                    statusView.setText(
                            "Cannot find the pc on this network. Check it is awake, then reopen capyTV.");
                });
            }
        });
    }

    private String readableAddress(String baseUrl) {
        return baseUrl.replace("http://", EMPTY_STRING);
    }

    private void setServerPill(String text, int colour) {
        serverPill.setText("●   " + text);
        serverPill.setTextColor(colour);
    }

    private void collectPendingPlayback() {
        if (serverBaseUrl.length() == 0) {
            return;
        }
        final String baseUrl = serverBaseUrl;
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
        root.setBackgroundColor(Theme.BACKGROUND);
        root.setPadding(64, 40, 64, 32);

        root.setClipChildren(false);
        root.addView(buildHeader());

        // Both scrollers must refuse focus. A ScrollView takes focus itself when it has no
        // focusable children, and then swallows every d-pad press trying to scroll: with an
        // empty list that leaves the remote completely dead on this screen.
        HorizontalScrollView tabScroller = new HorizontalScrollView(this);
        tabScroller.setHorizontalScrollBarEnabled(false);
        tabScroller.setFocusable(false);
        tabScroller.setFocusableInTouchMode(false);
        tabScroller.setDescendantFocusability(ViewGroup.FOCUS_AFTER_DESCENDANTS);
        tabScroller.setClipToPadding(false);
        tabScroller.setClipChildren(false);
        tabScroller.setPadding(0, 8, 0, 8);
        tabContainer = new LinearLayout(this);
        tabContainer.setClipChildren(false);
        tabContainer.setOrientation(LinearLayout.HORIZONTAL);
        tabScroller.addView(tabContainer, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        LinearLayout.LayoutParams tabsLayout = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tabsLayout.bottomMargin = 14;
        root.addView(tabScroller, tabsLayout);

        statusView = Theme.label(this, EMPTY_STRING, STATUS_TEXT_SIZE, Theme.TEXT_MUTED);
        statusView.setPadding(6, 8, 0, 18);
        statusView.setContentDescription(DESCRIPTION_STATUS);
        root.addView(statusView);

        ScrollView scroller = new ScrollView(this);
        scroller.setFocusable(false);
        scroller.setFocusableInTouchMode(false);
        scroller.setDescendantFocusability(ViewGroup.FOCUS_AFTER_DESCENDANTS);
        scroller.setVerticalScrollBarEnabled(false);
        scroller.setClipToPadding(false);
        scroller.setClipChildren(false);
        listContainer = new LinearLayout(this);
        listContainer.setClipChildren(false);
        listContainer.setOrientation(LinearLayout.VERTICAL);
        scroller.addView(listContainer, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(scroller, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        root.addView(buildActivityStrip());

        setContentView(root);
    }

    private View buildHeader() {
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);

        TextView mark = Theme.label(this, "🐹", 22, Theme.ACCENT_INK);
        mark.setBackground(Theme.box(Theme.ACCENT, Theme.ACCENT, 0, Theme.CARD_RADIUS));
        mark.setPadding(14, 10, 14, 12);
        header.addView(mark);

        TextView brand = Theme.label(this, "capyTV", HEADING_TEXT_SIZE, Theme.TEXT);
        brand.setPadding(20, 0, 0, 0);
        header.addView(brand);

        serverPill = Theme.chip(this, EMPTY_STRING, STATUS_TEXT_SIZE);
        serverPill.setContentDescription(DESCRIPTION_SERVER);
        LinearLayout.LayoutParams pillLayout = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        pillLayout.leftMargin = 32;
        pillLayout.gravity = Gravity.CENTER_VERTICAL;
        header.addView(serverPill, pillLayout);
        return header;
    }

    private View buildActivityStrip() {
        activityStrip = new LinearLayout(this);
        activityStrip.setOrientation(LinearLayout.VERTICAL);
        activityStrip.setBackground(Theme.box(Theme.SURFACE, Theme.LINE, Theme.STROKE_WIDTH, Theme.CARD_RADIUS));
        activityStrip.setPadding(26, 20, 26, 22);
        activityStrip.setVisibility(View.GONE);

        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL);

        activitySpinner = Theme.spinner(this, Theme.INFO);
        LinearLayout.LayoutParams spinnerLayout = new LinearLayout.LayoutParams(34, 34);
        spinnerLayout.rightMargin = 20;
        head.addView(activitySpinner, spinnerLayout);

        activityStageView = Theme.label(this, EMPTY_STRING, STRIP_STAGE_TEXT_SIZE, Theme.TEXT);
        activityStageView.setContentDescription(DESCRIPTION_ACTIVITY_STAGE);
        head.addView(activityStageView);
        activityStrip.addView(head);

        activityDetailView = Theme.label(this, EMPTY_STRING, STRIP_DETAIL_TEXT_SIZE, Theme.TEXT_SECONDARY);
        activityDetailView.setContentDescription(DESCRIPTION_ACTIVITY_DETAIL);
        activityDetailView.setPadding(54, 6, 0, 0);
        activityStrip.addView(activityDetailView);

        activityRail = Theme.rail(this, Theme.INFO);
        LinearLayout.LayoutParams railLayout = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, RAIL_HEIGHT);
        railLayout.topMargin = 16;
        railLayout.leftMargin = 54;
        activityStrip.addView(activityRail, railLayout);

        LinearLayout.LayoutParams stripLayout = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        stripLayout.topMargin = 20;
        activityStrip.setLayoutParams(stripLayout);
        return activityStrip;
    }

    private final Runnable activityPoller = new Runnable() {
        @Override
        public void run() {
            pollActivityOnce();
            handler.postDelayed(this,
                    somethingIsRunning ? ACTIVE_POLL_MILLISECONDS : IDLE_POLL_MILLISECONDS);
        }
    };

    private void pollActivityOnce() {
        if (serverBaseUrl.length() == 0) {
            return;
        }
        final String baseUrl = serverBaseUrl;
        new Thread(() -> {
            try {
                final String body = ServerApi.get(baseUrl + "/api/activity");
                final JSONArray running = new JSONObject(body).optJSONArray("running");
                handler.post(() -> renderActivity(running));
            } catch (Exception error) {
                Log.d(LOG_TAG, "activity poll failed: " + error.getMessage());
                handler.post(() -> renderActivity(new JSONArray()));
            }
        }).start();
    }

    private void renderActivity(JSONArray running) {
        if (screenIsLive == false) {
            return;
        }
        int count = running == null ? NO_ITEMS : running.length();
        somethingIsRunning = count > NO_ITEMS;
        if (somethingIsRunning == false) {
            activityStrip.setVisibility(View.GONE);
            return;
        }
        JSONObject entry = running.optJSONObject(FIRST_INDEX);
        String stage = entry.optString("stage", EMPTY_STRING);
        String label = entry.optString("label", EMPTY_STRING);
        String detail = entry.optString("detail", EMPTY_STRING);
        int percent = entry.optInt("percent", INDETERMINATE_PERCENT);
        boolean isDownload = KIND_DOWNLOAD.equals(entry.optString("kind"));
        int tone = isDownload ? Theme.ACCENT : Theme.INFO;

        if (count > 1) {
            stage = stage + SEPARATOR + "and " + (count - 1) + " more";
        }
        if (percent >= 0) {
            stage = stage + SEPARATOR + percent + "%";
        }
        activityStageView.setText(stage);
        activityDetailView.setText(buildActivityDetail(label, detail));
        activityDetailView.setVisibility(
                buildActivityDetail(label, detail).length() == 0 ? View.GONE : View.VISIBLE);
        activitySpinner.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(tone));
        activityRail.setProgressTintList(android.content.res.ColorStateList.valueOf(tone));
        activityRail.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(tone));
        activityRail.setIndeterminate(percent < 0);
        if (percent >= 0) {
            activityRail.setProgress(percent);
        }
        activityStrip.setVisibility(View.VISIBLE);
    }

    private String buildActivityDetail(String label, String detail) {
        if (label.length() > 0 && detail.length() > 0) {
            return label + SEPARATOR + detail;
        } else if (label.length() > 0) {
            return label;
        } else {
            return detail;
        }
    }

    private void reloadSections() {
        final String baseUrl = serverBaseUrl;
        new Thread(() -> {
            try {
                final String body = ServerApi.get(baseUrl + "/api/collections");
                final JSONArray collections = new JSONObject(body).getJSONArray("items");
                handler.post(() -> {
                    renderTabs(collections);
                    loadOpenSection();
                });
            } catch (Exception error) {
                Log.w(LOG_TAG, "collection list failed", error);
                handler.post(() -> {
                    ServerLocator.forgetBaseUrl(HomeActivity.this);
                    setServerPill("lost the pc", Theme.BAD);
                    statusView.setText("Lost the pc at " + baseUrl + ". Reopen capyTV to search again.");
                });
            }
        }).start();
    }

    // Rebuilding the tabs destroys whichever one had focus, and the list that would normally
    // take it over is still being fetched. Without this the remote is dead for that gap.
    private void renderTabs(JSONArray collections) {
        boolean tabsHadFocus = tabContainer.findFocus() != null;
        tabContainer.removeAllViews();
        tabContainer.addView(buildTab(MAIN_COLLECTION, "links"));
        for (int index = 0; index < collections.length(); index += 1) {
            JSONObject entry = collections.optJSONObject(index);
            String name = entry == null ? EMPTY_STRING : entry.optString("name", EMPTY_STRING);
            if (name.length() > 0 && name.equals(MAIN_COLLECTION) == false) {
                tabContainer.addView(buildTab(name, name + " (" + entry.optInt("count") + ")"));
            }
        }
        tabContainer.addView(buildTab(DOWNLOADS_SECTION, "downloads"));
        if (tabsHadFocus || nothingHasFocus()) {
            focusOpenTab();
        }
    }

    private boolean nothingHasFocus() {
        View focused = getWindow().getDecorView().findFocus();
        return focused == null || focused.isFocusable() == false;
    }

    private View buildTab(final String section, String label) {
        final boolean isOpen = section.equals(openSection);
        Button tab = new Button(this);
        tab.setTag(section);
        tab.setContentDescription(DESCRIPTION_TAB_PREFIX + section);
        tab.setText(label);
        tab.setTextSize(TAB_TEXT_SIZE);
        tab.setTextColor(isOpen ? Theme.TEXT : Theme.TEXT_SECONDARY);
        tab.setAllCaps(false);
        tab.setPadding(40, 20, 40, 20);
        tab.setBackground(Theme.tab(false, isOpen));
        tab.setStateListAnimator(null);
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        layout.rightMargin = TAB_RIGHT_MARGIN;
        tab.setLayoutParams(layout);
        tab.setOnFocusChangeListener((view, focused) -> {
            view.setBackground(Theme.tab(focused, isOpen));
            ((Button) view).setTextColor(focused ? Theme.ACCENT_INK
                    : (isOpen ? Theme.TEXT : Theme.TEXT_SECONDARY));
            Theme.applyFocusLift(view, focused);
        });
        tab.setOnClickListener(view -> {
            openSection = section;
            reloadSections();
        });
        return tab;
    }

    private void loadOpenSection() {
        if (openSection.equals(DOWNLOADS_SECTION)) {
            loadSavedMedia();
        } else {
            loadLinks(openSection);
        }
    }

    private void loadLinks(final String collection) {
        final String baseUrl = serverBaseUrl;
        statusView.setText("Loading " + collection + "...");
        new Thread(() -> {
            try {
                final String body = ServerApi.get(baseUrl + "/api/links?collection=" + collection);
                final JSONArray items = new JSONObject(body).getJSONArray("items");
                handler.post(() -> renderLinks(items, collection));
            } catch (Exception error) {
                Log.w(LOG_TAG, "link list failed", error);
                handler.post(() -> statusView.setText("Cannot reach the pc at " + baseUrl));
            }
        }).start();
    }

    private void loadSavedMedia() {
        final String baseUrl = serverBaseUrl;
        statusView.setText("Loading what is saved on the pc...");
        new Thread(() -> {
            try {
                final String body = ServerApi.get(baseUrl + "/api/library");
                final JSONArray items = new JSONObject(body).getJSONArray("items");
                handler.post(() -> renderSavedMedia(items));
            } catch (Exception error) {
                Log.w(LOG_TAG, "saved media list failed", error);
                handler.post(() -> statusView.setText("Cannot reach the pc at " + baseUrl));
            }
        }).start();
    }

    private void renderLinks(JSONArray items, String collection) {
        listContainer.removeAllViews();
        if (items.length() == 0) {
            statusView.setText("Nothing in " + collection + " yet. Paste a link on your phone.");
            focusOpenTab();
            return;
        }
        statusView.setText(items.length() + " links. Selecting one loads it fresh from the pc.");
        for (int index = 0; index < items.length(); index += 1) {
            JSONObject item = items.optJSONObject(index);
            if (item != null) {
                final String sourceUrl = item.optString("url");
                listContainer.addView(buildRow(
                        item.optString("title", sourceUrl),
                        sourceUrl,
                        view -> sendLink(sourceUrl, collection)));
            }
        }
        focusFirstRow();
    }

    private void renderSavedMedia(JSONArray items) {
        listContainer.removeAllViews();
        if (items.length() == 0) {
            statusView.setText("Nothing saved on the pc yet. Use the downloads button on your phone.");
            focusOpenTab();
            return;
        }
        statusView.setText(items.length() + " videos saved on the pc.");
        for (int index = 0; index < items.length(); index += 1) {
            JSONObject item = items.optJSONObject(index);
            if (item != null) {
                final String itemIdentifier = item.optString("id");
                String detail = item.optString("folder");
                if (item.optBoolean("hasSubtitle")) {
                    detail = detail + SEPARATOR + "subtitles";
                }
                listContainer.addView(buildRow(
                        item.optString("title", itemIdentifier),
                        detail,
                        view -> sendSavedMedia(itemIdentifier)));
            }
        }
        focusFirstRow();
    }

    // With rows, land on the first one. Without any, land on the open tab, or the remote has
    // nothing to hold and the screen cannot be navigated at all.
    private void focusFirstRow() {
        if (listContainer.getChildCount() > 0) {
            listContainer.getChildAt(FIRST_INDEX).requestFocus();
        } else {
            focusOpenTab();
        }
    }

    private void focusOpenTab() {
        for (int index = 0; index < tabContainer.getChildCount(); index += 1) {
            View tab = tabContainer.getChildAt(index);
            if (openSection.equals(tab.getTag())) {
                tab.requestFocus();
                return;
            }
        }
        if (tabContainer.getChildCount() > 0) {
            tabContainer.getChildAt(FIRST_INDEX).requestFocus();
        }
    }

    private CharSequence buildRowText(String title, String detail) {
        if (detail.length() == 0) {
            return title;
        }
        String combined = title + "\n" + detail;
        SpannableString styled = new SpannableString(combined);
        int detailStart = title.length() + 1;
        styled.setSpan(new RelativeSizeSpan(DETAIL_RELATIVE_SIZE), detailStart, combined.length(),
                Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        styled.setSpan(new ForegroundColorSpan(Theme.TEXT_MUTED), detailStart, combined.length(),
                Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        return styled;
    }

    private View buildRow(String title, String detail, View.OnClickListener onSelect) {
        Button row = new Button(this);
        row.setContentDescription(DESCRIPTION_ROW);
        row.setText(buildRowText(title, detail));
        row.setTextSize(ROW_TEXT_SIZE);
        row.setTextColor(Color.WHITE);
        row.setAllCaps(false);
        row.setLineSpacing(6f, 1f);
        row.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        row.setPadding(34, 26, 34, 28);
        row.setBackground(Theme.card(false));
        row.setStateListAnimator(null);
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        layout.bottomMargin = ROW_BOTTOM_MARGIN;
        row.setLayoutParams(layout);
        row.setOnFocusChangeListener((view, focused) -> {
            view.setBackground(Theme.card(focused));
            Theme.applyFocusLift(view, focused);
        });
        row.setOnClickListener(onSelect);
        return row;
    }

    private void sendLink(final String sourceUrl, final String collection) {
        final String baseUrl = serverBaseUrl;
        statusView.setText("Loading the newest version of that link...");
        wakeActivityPolling();
        new Thread(() -> {
            try {
                JSONObject request = new JSONObject();
                request.put("url", sourceUrl);
                request.put("collection", collection);
                ServerApi.post(baseUrl + "/api/send", request.toString());
                Log.i(LOG_TAG, "asked the pc to resolve and send " + sourceUrl);
            } catch (Exception error) {
                Log.w(LOG_TAG, "could not send that link", error);
                handler.post(() -> statusView.setText("Could not load that link: " + error.getMessage()));
            }
        }).start();
    }

    private void sendSavedMedia(final String itemIdentifier) {
        final String baseUrl = serverBaseUrl;
        statusView.setText("Starting that file...");
        wakeActivityPolling();
        new Thread(() -> {
            try {
                JSONObject request = new JSONObject();
                request.put("publicationId", "file:" + itemIdentifier);
                ServerApi.post(baseUrl + "/api/send", request.toString());
                Log.i(LOG_TAG, "asked the pc to play saved media " + itemIdentifier);
            } catch (Exception error) {
                Log.w(LOG_TAG, "could not play that file", error);
                handler.post(() -> statusView.setText("Could not play that file: " + error.getMessage()));
            }
        }).start();
    }

    private void wakeActivityPolling() {
        somethingIsRunning = true;
        handler.removeCallbacks(activityPoller);
        handler.postDelayed(activityPoller, ACTIVE_POLL_MILLISECONDS);
    }
}
