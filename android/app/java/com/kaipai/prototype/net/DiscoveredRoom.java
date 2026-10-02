package com.kaipai.prototype.net;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 一条探测结果。字段与协议 §6 的应答一致。
 *
 * 原先是 RoomDiscovery 的公有静态内部类（RoomDiscovery$Room），提成顶层类
 * 是为了让 class 名里不含 '$'。名字从 Room 改成 DiscoveredRoom 以免和其它
 * 包的通用名字混淆，行为一行未改。
 */
public final class DiscoveredRoom {
    public final String room;
    public final String host;
    public final String ip;
    public final int port;
    public final int players;
    public final boolean started;
    public final int version;

    DiscoveredRoom(Map<String, Object> m, String fallbackIp) {
        this.room = Json.str(m, "room", "卡牌对决");
        this.host = Json.str(m, "host", "");
        String rawIp = Json.str(m, "ip", "");
        this.ip = rawIp.isEmpty() ? fallbackIp : rawIp;
        this.port = Json.intVal(m, "port", HttpGameServer.DEFAULT_PORT);
        this.players = Json.intVal(m, "players", 1);
        this.started = Json.boolVal(m, "started", false);
        this.version = Json.intVal(m, "version", HttpGameServer.VERSION);
    }

    public String key() {
        return ip + ":" + port;
    }

    public String toJson() {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("t", "room");
        m.put("room", room);
        m.put("host", host);
        m.put("ip", ip);
        m.put("port", (long) port);
        m.put("players", (long) players);
        m.put("started", started);
        m.put("version", (long) version);
        return Json.encode(m);
    }
}
