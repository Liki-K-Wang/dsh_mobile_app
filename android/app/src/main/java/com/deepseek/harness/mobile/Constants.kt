package com.deepseek.harness.mobile

/** 连接模式常量与文案。 */
const val MODE_LAN = "lan"
const val MODE_WAN = "wan"
const val MODE_UNKNOWN = "none"

fun modeLabel(mode: String?): String = when (mode) {
    MODE_LAN -> "局域网"
    MODE_WAN -> "远程"
    else -> "未连接"
}
