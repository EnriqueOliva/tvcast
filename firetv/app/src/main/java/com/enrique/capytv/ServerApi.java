package com.enrique.capytv;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public final class ServerApi {

    private static final int CONNECT_TIMEOUT_MILLISECONDS = 4000;
    private static final int READ_TIMEOUT_MILLISECONDS = 15000;
    private static final int BUFFER_SIZE = 8192;
    private static final int HTTP_MULTIPLE_CHOICES = 300;

    private ServerApi() {
    }

    public static String get(String url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MILLISECONDS);
        connection.setReadTimeout(READ_TIMEOUT_MILLISECONDS);
        connection.setRequestMethod("GET");
        try {
            return readResponse(connection);
        } finally {
            connection.disconnect();
        }
    }

    public static String post(String url, String jsonBody) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MILLISECONDS);
        connection.setReadTimeout(READ_TIMEOUT_MILLISECONDS);
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        try {
            OutputStream output = connection.getOutputStream();
            output.write(jsonBody.getBytes(StandardCharsets.UTF_8));
            output.close();
            return readResponse(connection);
        } finally {
            connection.disconnect();
        }
    }

    private static String readResponse(HttpURLConnection connection) throws Exception {
        int status = connection.getResponseCode();
        InputStream stream = status < HTTP_MULTIPLE_CHOICES
                ? connection.getInputStream()
                : connection.getErrorStream();
        if (stream == null) {
            return "";
        }
        ByteArrayOutputStream collected = new ByteArrayOutputStream();
        byte[] buffer = new byte[BUFFER_SIZE];
        int read = stream.read(buffer);
        while (read > 0) {
            collected.write(buffer, 0, read);
            read = stream.read(buffer);
        }
        stream.close();
        String body = collected.toString(StandardCharsets.UTF_8.name());
        if (status >= HTTP_MULTIPLE_CHOICES) {
            throw new Exception("HTTP " + status + " " + body);
        }
        return body;
    }
}
