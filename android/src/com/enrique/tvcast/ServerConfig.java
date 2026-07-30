package com.enrique.tvcast;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public final class ServerConfig {

    private static final String PREFERENCES_NAME = "tvcast";
    private static final String KEY_BASE_URL = "baseUrl";
    private static final String DEFAULT_BASE_URL = "http://192.168.1.8:8787";
    private static final int CONNECT_TIMEOUT_MILLISECONDS = 6000;
    private static final int READ_TIMEOUT_MILLISECONDS = 120000;

    private ServerConfig() {
    }

    public static String getBaseUrl(Context context) {
        SharedPreferences preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
        return preferences.getString(KEY_BASE_URL, DEFAULT_BASE_URL);
    }

    public static void setBaseUrl(Context context, String baseUrl) {
        String trimmed = baseUrl.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        if (trimmed.startsWith("http://") == false && trimmed.startsWith("https://") == false) {
            trimmed = "http://" + trimmed;
        }
        context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
                .edit().putString(KEY_BASE_URL, trimmed).apply();
    }

    public static String postJson(Context context, String path, JSONObject payload) throws Exception {
        URL endpoint = new URL(getBaseUrl(context) + path);
        HttpURLConnection connection = (HttpURLConnection) endpoint.openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(CONNECT_TIMEOUT_MILLISECONDS);
        connection.setReadTimeout(READ_TIMEOUT_MILLISECONDS);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");

        byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
        OutputStream outputStream = connection.getOutputStream();
        outputStream.write(body);
        outputStream.close();

        int statusCode = connection.getResponseCode();
        BufferedReader reader = new BufferedReader(new InputStreamReader(
                statusCode >= 400 ? connection.getErrorStream() : connection.getInputStream(),
                StandardCharsets.UTF_8));
        StringBuilder builder = new StringBuilder();
        String line = reader.readLine();
        while (line != null) {
            builder.append(line);
            line = reader.readLine();
        }
        reader.close();
        connection.disconnect();

        String responseText = builder.toString();
        if (statusCode >= 400) {
            String message = responseText;
            try {
                message = new JSONObject(responseText).optString("error", responseText);
            } catch (Exception parseError) {
                message = responseText;
            }
            throw new Exception(message);
        }
        return responseText;
    }
}
