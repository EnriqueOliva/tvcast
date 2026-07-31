package com.enrique.tvcast;

import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class TinyHttpServer {

    public interface RequestHandler {
        String handle(String method, String path, String body);
    }

    private static final String LOG_TAG = "tvcast";
    private static final int WORKER_COUNT = 4;
    private static final int READ_BUFFER_SIZE = 4096;
    private static final int SOCKET_TIMEOUT_MILLISECONDS = 10000;
    private static final String HEADER_TERMINATOR = "\r\n\r\n";

    private final int port;
    private final RequestHandler handler;
    private final ExecutorService workers = Executors.newFixedThreadPool(WORKER_COUNT);

    private ServerSocket serverSocket;
    private Thread acceptThread;
    private volatile boolean running;

    public TinyHttpServer(int port, RequestHandler handler) {
        this.port = port;
        this.handler = handler;
    }

    public void start() {
        if (running) {
            return;
        }
        running = true;
        acceptThread = new Thread(this::acceptLoop, "tvcast-http");
        acceptThread.start();
    }

    public void stop() {
        running = false;
        try {
            if (serverSocket != null) {
                serverSocket.close();
            }
        } catch (Exception error) {
            Log.d(LOG_TAG, "listener shutdown: " + error.getMessage());
        }
        workers.shutdownNow();
    }

    private void acceptLoop() {
        try {
            serverSocket = new ServerSocket(port);
            Log.i(LOG_TAG, "listener up on port " + port);
            while (running) {
                Socket client = serverSocket.accept();
                workers.execute(() -> serve(client));
            }
        } catch (Exception error) {
            if (running) {
                Log.e(LOG_TAG, "listener died: " + error.getMessage());
            }
        }
    }

    private void serve(Socket client) {
        try {
            client.setSoTimeout(SOCKET_TIMEOUT_MILLISECONDS);
            InputStream input = client.getInputStream();
            ByteArrayOutputStream collected = new ByteArrayOutputStream();
            byte[] buffer = new byte[READ_BUFFER_SIZE];

            int headerEnd = -1;
            while (headerEnd < 0) {
                int read = input.read(buffer);
                if (read <= 0) {
                    break;
                }
                collected.write(buffer, 0, read);
                headerEnd = collected.toString(StandardCharsets.UTF_8.name()).indexOf(HEADER_TERMINATOR);
            }

            String raw = collected.toString(StandardCharsets.UTF_8.name());
            if (headerEnd < 0) {
                client.close();
                return;
            }

            String headerBlock = raw.substring(0, headerEnd);
            String[] headerLines = headerBlock.split("\r\n");
            String[] requestLine = headerLines[0].split(" ");
            String method = requestLine.length > 0 ? requestLine[0] : "GET";
            String path = requestLine.length > 1 ? requestLine[1] : "/";

            int contentLength = 0;
            for (String line : headerLines) {
                if (line.toLowerCase().startsWith("content-length:")) {
                    contentLength = Integer.parseInt(line.substring(line.indexOf(':') + 1).trim());
                }
            }

            StringBuilder body = new StringBuilder(raw.substring(headerEnd + HEADER_TERMINATOR.length()));
            while (body.toString().getBytes(StandardCharsets.UTF_8).length < contentLength) {
                int read = input.read(buffer);
                if (read <= 0) {
                    break;
                }
                body.append(new String(buffer, 0, read, StandardCharsets.UTF_8));
            }

            String responseBody = handler.handle(method, path, body.toString());
            byte[] payload = responseBody.getBytes(StandardCharsets.UTF_8);
            OutputStream output = client.getOutputStream();
            output.write(("HTTP/1.1 200 OK\r\n"
                    + "Content-Type: application/json; charset=utf-8\r\n"
                    + "Content-Length: " + payload.length + "\r\n"
                    + "Connection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            output.write(payload);
            output.flush();
            client.close();
        } catch (Exception error) {
            Log.w(LOG_TAG, "request failed: " + error.getMessage());
            try {
                client.close();
            } catch (Exception ignored) {
                Log.d(LOG_TAG, "close failed");
            }
        }
    }
}
