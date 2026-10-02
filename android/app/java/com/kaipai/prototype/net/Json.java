package com.kaipai.prototype.net;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 极简 JSON 编解码。
 *
 * 为什么要自己写：
 *   本工程刻意零第三方依赖（不引 Gradle / Maven / AndroidX），
 *   而 Android 自带的 org.json 在桌面 JVM 上没有 —— 一旦用了它，
 *   net/ 下的代码就没法在开发机上直接跑测试，联机逻辑就只能靠真机试。
 *   代价是这个类只覆盖协议真正用到的子集：对象 / 数组 / 字符串 / 数字 / 布尔 / null。
 *
 * 约定：
 *   · 解码得到 Map&lt;String,Object&gt; / List&lt;Object&gt; / String / Double / Boolean / null。
 *     数字统一解析成 Double 会让 seq、step 这类整数字段带 ".0"，所以这里
 *     整数（不含 . e E）解析为 Long，其余为 Double —— 编码和比较都更省心。
 *   · 编码不做「数字原样保留」的优化，Double 用最短表示，Long 直接输出。
 *   · 解析失败抛 JsonException（RuntimeException），调用方按「坏请求」处理。
 *
 * 注：解析器与异常类型原先是本类的内部类，现在分别是顶层类 JsonParser /
 * JsonException —— 工程里不再有 class 名带 '$' 的产物。
 */
public final class Json {

    private Json() {
    }

    // ── 编码 ────────────────────────────────────────────────

    public static String encode(Object v) {
        StringBuilder sb = new StringBuilder();
        write(sb, v);
        return sb.toString();
    }

    private static void write(StringBuilder sb, Object v) {
        if (v == null) {
            sb.append("null");
        } else if (v instanceof String) {
            writeString(sb, (String) v);
        } else if (v instanceof Boolean) {
            sb.append(((Boolean) v) ? "true" : "false");
        } else if (v instanceof Double || v instanceof Float) {
            double d = ((Number) v).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) {
                // JSON 没有 NaN/Infinity，退化成 null 比产生非法 JSON 好
                sb.append("null");
            } else if (d == Math.floor(d) && Math.abs(d) < 1e15) {
                // 5.0 写成 5：协议里的 seq/port/step 都是整数量，带小数点会让 JS 侧看着别扭
                sb.append((long) d);
            } else {
                sb.append(d);
            }
        } else if (v instanceof Number) {
            sb.append(v.toString());
        } else if (v instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (!first) sb.append(',');
                first = false;
                writeString(sb, String.valueOf(e.getKey()));
                sb.append(':');
                write(sb, e.getValue());
            }
            sb.append('}');
        } else if (v instanceof Iterable) {
            sb.append('[');
            boolean first = true;
            for (Object o : (Iterable<?>) v) {
                if (!first) sb.append(',');
                first = false;
                write(sb, o);
            }
            sb.append(']');
        } else if (v instanceof Object[]) {
            sb.append('[');
            Object[] arr = (Object[]) v;
            for (int i = 0; i < arr.length; i++) {
                if (i > 0) sb.append(',');
                write(sb, arr[i]);
            }
            sb.append(']');
        } else {
            // 兜底：转成字符串也比抛异常好，至少协议管道不断
            writeString(sb, String.valueOf(v));
        }
    }

    private static void writeString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n");  break;
                case '\r': sb.append("\\r");  break;
                case '\t': sb.append("\\t");  break;
                case '\b': sb.append("\\b");  break;
                case '\f': sb.append("\\f");  break;
                default:
                    // 控制字符必须转义，否则非法 JSON；其余（含中文）按 UTF-8 原样输出
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    // ── 解码 ────────────────────────────────────────────────

    public static Object decode(String s) {
        if (s == null) throw new JsonException("null input");
        JsonParser p = new JsonParser(s);
        p.skipWs();
        Object v = p.value();
        p.skipWs();
        if (p.pos < p.len) throw new JsonException("尾部有多余字符 @" + p.pos);
        return v;
    }

    /** 便捷方法：解析请求体并断言是对象。 */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> decodeObject(String s) {
        Object v = decode(s);
        if (!(v instanceof Map)) throw new JsonException("期望 JSON 对象");
        return (Map<String, Object>) v;
    }

    /** 新的空对象（保序，便于调试时肉眼看字段顺序）。 */
    public static Map<String, Object> obj() {
        return new LinkedHashMap<String, Object>();
    }

    // ── 取值助手：协议里到处都是「可选字段 + 默认值」 ──────────────

    public static String str(Map<String, Object> m, String key, String def) {
        Object v = m == null ? null : m.get(key);
        return v == null ? def : String.valueOf(v);
    }

    public static int intVal(Map<String, Object> m, String key, int def) {
        Object v = m == null ? null : m.get(key);
        if (v instanceof Number) return ((Number) v).intValue();
        if (v instanceof String) {
            try {
                return (int) Double.parseDouble((String) v);
            } catch (NumberFormatException ignored) {
                return def;
            }
        }
        return def;
    }

    public static boolean boolVal(Map<String, Object> m, String key, boolean def) {
        Object v = m == null ? null : m.get(key);
        if (v instanceof Boolean) return ((Boolean) v).booleanValue();
        if (v instanceof String) return "true".equalsIgnoreCase((String) v);
        return def;
    }
}
