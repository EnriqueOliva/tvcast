package com.enrique.tvcast;

import android.content.Context;
import android.content.SharedPreferences;

public final class ServerLocator {

    private static final String PREFERENCES_NAME = "tvcast";
    private static final String BASE_URL_KEY = "serverBaseUrl";
    private static final String EMPTY_STRING = "";
    private static final int SERVER_PORT = 8787;

    private ServerLocator() {
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
    }

    public static String getBaseUrl(Context context) {
        return preferences(context).getString(BASE_URL_KEY, EMPTY_STRING);
    }

    public static void setBaseUrl(Context context, String baseUrl) {
        if (baseUrl == null || baseUrl.length() == 0) {
            return;
        }
        preferences(context).edit().putString(BASE_URL_KEY, baseUrl).apply();
    }

    public static String buildCandidateBaseUrl(String hostAddress) {
        return "http://" + hostAddress + ":" + SERVER_PORT;
    }
}
