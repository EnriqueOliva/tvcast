package com.enrique.capytv;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class CueTrack {

    private final long[] startMilliseconds;
    private final long[] endMilliseconds;
    private final String[] texts;

    private CueTrack(long[] startMilliseconds, long[] endMilliseconds, String[] texts) {
        this.startMilliseconds = startMilliseconds;
        this.endMilliseconds = endMilliseconds;
        this.texts = texts;
    }

    public static CueTrack parse(String json) throws Exception {
        JSONArray array = new JSONArray(json);
        int count = array.length();
        long[] starts = new long[count];
        long[] ends = new long[count];
        String[] lines = new String[count];
        for (int index = 0; index < count; index += 1) {
            JSONObject entry = array.getJSONObject(index);
            starts[index] = entry.getLong("s");
            ends[index] = entry.getLong("e");
            lines[index] = entry.getString("t");
        }
        return new CueTrack(starts, ends, lines);
    }

    public static CueTrack empty() {
        return new CueTrack(new long[0], new long[0], new String[0]);
    }

    public int size() {
        return texts.length;
    }

    public long activeStartMilliseconds(long lookupMilliseconds) {
        for (int index = 0; index < texts.length; index += 1) {
            if (startMilliseconds[index] <= lookupMilliseconds && endMilliseconds[index] > lookupMilliseconds) {
                return startMilliseconds[index];
            }
        }
        return -1;
    }

    public List<String> textAt(long lookupMilliseconds) {
        if (texts.length == 0) {
            return Collections.emptyList();
        }
        int low = 0;
        int high = texts.length - 1;
        int candidate = -1;
        while (low <= high) {
            int middle = (low + high) >>> 1;
            if (startMilliseconds[middle] <= lookupMilliseconds) {
                candidate = middle;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        if (candidate < 0) {
            return Collections.emptyList();
        }
        List<String> active = new ArrayList<String>(2);
        int scan = candidate;
        while (scan >= 0 && startMilliseconds[scan] <= lookupMilliseconds) {
            if (endMilliseconds[scan] > lookupMilliseconds) {
                active.add(0, texts[scan]);
            }
            if (candidate - scan > 4) {
                break;
            }
            scan -= 1;
        }
        return active;
    }
}
