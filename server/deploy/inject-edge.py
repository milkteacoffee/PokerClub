#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把棋牌后端 location 片段注入 edge-nginx 的 edge.conf 中 modelghost.cn 的 server 块。
幂等、可回滚、改前后都做语法验证（由外层脚本调 nginx -t）。
"""
import io
import os
import sys

CONF = "/opt/modelghost-platform/nginx/edge.conf"
SNIP = "/opt/pokerclub/deploy/edge-poker-snippet.conf"
MARK = "# ===== 赌途（PokerClub）棋牌后端"
MARK_ASCII = "PokerClub"  # 兼容编码问题，用 ASCII 锚点判断


def main():
    if not os.path.exists(CONF):
        print("ERROR: 找不到 " + CONF)
        return 2
    if not os.path.exists(SNIP):
        print("ERROR: 找不到片段 " + SNIP)
        return 2

    with io.open(CONF, "r", encoding="utf-8") as f:
        text = f.read()
    with io.open(SNIP, "r", encoding="utf-8") as f:
        snippet = f.read().rstrip("\n")

    # 幂等
    if "/_poker/api/" in text:
        print("SKIP: 已注入过（发现 /_poker/api/）")
        return 0

    # 备份（保留首次）
    bak = CONF + ".bak-poker"
    if not os.path.exists(bak):
        with io.open(bak, "w", encoding="utf-8") as f:
            f.write(text)
        print("备份: " + bak)
    else:
        print("备份已存在，保留首次版本: " + bak)

    lines = text.split("\n")

    # 1) 用状态机解析所有顶层 server 块，挑出「listen 443」且 server_name 含 modelghost.cn 的那个
    #    纯文本回溯容易错（注释/ssl 指令会隔开 listen 与 server_name），必须整块判定。
    blocks = []          # [(start_idx, end_idx)] 0-based，含首含尾
    depth = 0
    cur_start = None
    for i, ln in enumerate(lines):
        opens = ln.count("{")
        closes = ln.count("}")
        if opens and cur_start is None:
            cur_start = i
        depth += opens - closes
        if cur_start is not None and depth == 0:
            blocks.append((cur_start, i))
            cur_start = None

    print("解析出 %d 个 server 块" % len(blocks))
    start = None
    end = None
    for (bs, be) in blocks:
        body = "\n".join(lines[bs:be + 1])
        flat = body.replace(" ", "")
        if "listen443" not in flat:
            continue
        if "server_namemodelghost.cnwww.modelghost.cn;" not in flat:
            continue
        start, end = bs, be
        print("锁定 443 ssl 主站块: 第 %d 行 ~ 第 %d 行" % (start + 1, end + 1))
        break

    if start is None:
        print("ERROR: 未找到 listen 443 + server_name modelghost.cn www.modelghost.cn 的块")
        return 3

    # 2.5) 安全检查：这个块里必须有 ssl_certificate，否则说明找错了块
    block_body = "\n".join(lines[start:end + 1])
    if "ssl_certificate" not in block_body or "listen 443" not in block_body:
        print("ERROR: 目标块不含 listen 443 / ssl_certificate，疑似找错块，放弃")
        return 3
    if "/api/" not in block_body:
        print("WARN: 目标块内没看到 /api/，请人工确认")

    # 3) 在该块内为片段加上一级缩进（片段本身按 0 缩进写），插到闭合括号之前
    indented = []
    for ln in snippet.split("\n"):
        indented.append(("    " + ln) if ln.strip() else ln)

    new_lines = lines[:end] + [""] + indented + lines[end:]
    new_text = "\n".join(new_lines)

    if MARK_ASCII not in new_text:
        print("ERROR: 注入后未发现标记，放弃")
        return 3

    with io.open(CONF, "w", encoding="utf-8") as f:
        f.write(new_text)
    print("OK: 已注入，配置 %d 行 -> %d 行" % (len(lines), len(new_lines)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
