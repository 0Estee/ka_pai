package com.kaipai.prototype.net;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * JSON 递归下降解析器。只覆盖协议真正用到的子集（见 Json 的类注释）。
 *
 * 原先是 Json 的私有静态内部类（Json$Parser），提成顶层类是为了让 class 名里
 * 不含 '$'。逻辑一行未改：解析失败一律抛 JsonException。
 */
final class JsonParser {
    private final String s;
    // len / pos 保持包内可见：Json.decode 需要检查「解析结束后有没有剩余字符」。
    // 原先 Parser 是 Json 的内部类，private 字段对 Json 也是可见的；提成顶层类后
    // 必须放宽到包内可见，行为不变。
    final int len;
    int pos;

    JsonParser(String s) {
        this.s = s;
        this.len = s.length();
    }

    void skipWs() {
        while (pos < len) {
            char c = s.charAt(pos);
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') pos++;
            else break;
        }
    }

    Object value() {
        if (pos >= len) throw new JsonException("意外结束");
        char c = s.charAt(pos);
        switch (c) {
            case '{': return object();
            case '[': return array();
            case '"': return string();
            case 't': expect("true"); return Boolean.TRUE;
            case 'f': expect("false"); return Boolean.FALSE;
            case 'n': expect("null"); return null;
            default:  return number();
        }
    }

    private void expect(String lit) {
        if (!s.startsWith(lit, pos)) throw new JsonException("期望 " + lit + " @" + pos);
        pos += lit.length();
    }

    private Map<String, Object> object() {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        pos++; // {
        skipWs();
        if (pos < len && s.charAt(pos) == '}') { pos++; return m; }
        while (true) {
            skipWs();
            if (pos >= len || s.charAt(pos) != '"') throw new JsonException("对象键必须是字符串 @" + pos);
            String k = string();
            skipWs();
            if (pos >= len || s.charAt(pos) != ':') throw new JsonException("缺少 ':' @" + pos);
            pos++;
            skipWs();
            m.put(k, value());
            skipWs();
            if (pos >= len) throw new JsonException("对象未闭合 @" + pos);
            char c = s.charAt(pos);
            if (c == ',') { pos++; continue; }
            if (c == '}') { pos++; return m; }
            throw new JsonException("对象里出现意外字符 '" + c + "' @" + pos);
        }
    }

    private List<Object> array() {
        List<Object> list = new ArrayList<Object>();
        pos++; // [
        skipWs();
        if (pos < len && s.charAt(pos) == ']') { pos++; return list; }
        while (true) {
            skipWs();
            list.add(value());
            skipWs();
            if (pos >= len) throw new JsonException("数组未闭合 @" + pos);
            char c = s.charAt(pos);
            if (c == ',') { pos++; continue; }
            if (c == ']') { pos++; return list; }
            throw new JsonException("数组里出现意外字符 '" + c + "' @" + pos);
        }
    }

    private String string() {
        pos++; // 开引号
        StringBuilder sb = new StringBuilder();
        while (true) {
            if (pos >= len) throw new JsonException("字符串未闭合");
            char c = s.charAt(pos++);
            if (c == '"') return sb.toString();
            if (c != '\\') { sb.append(c); continue; }
            if (pos >= len) throw new JsonException("转义序列未结束");
            char e = s.charAt(pos++);
            switch (e) {
                case '"':  sb.append('"');  break;
                case '\\': sb.append('\\'); break;
                case '/':  sb.append('/');  break;
                case 'n':  sb.append('\n'); break;
                case 'r':  sb.append('\r'); break;
                case 't':  sb.append('\t'); break;
                case 'b':  sb.append('\b'); break;
                case 'f':  sb.append('\f'); break;
                case 'u':
                    if (pos + 4 > len) throw new JsonException("\\u 后不足 4 位");
                    sb.append((char) Integer.parseInt(s.substring(pos, pos + 4), 16));
                    pos += 4;
                    break;
                default: throw new JsonException("未知转义 \\" + e);
            }
        }
    }

    private Object number() {
        int start = pos;
        if (pos < len && s.charAt(pos) == '-') pos++;
        boolean frac = false;
        while (pos < len) {
            char c = s.charAt(pos);
            if (c >= '0' && c <= '9') { pos++; continue; }
            if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
                // 指数部分里的 +/- 也要吃进来（1e+3），但不能当成前导符号
                if (c == '.' || c == 'e' || c == 'E') frac = true;
                pos++;
                continue;
            }
            break;
        }
        String num = s.substring(start, pos);
        if (num.isEmpty()) throw new JsonException("不是合法 JSON 值 @" + start);
        try {
            return frac ? (Object) Double.valueOf(num) : (Object) Long.valueOf(num);
        } catch (NumberFormatException ex) {
            throw new JsonException("非法数字 " + num);
        }
    }
}
