# WeatherCN Pro v1.2 iPhone Ready

这是 WeatherCN Pro 的 iPhone 可用稳定版，只做 Loon 安装稳定性、脚本超时、缓存和失败回退修正，不新增功能。

## 插件 Raw 链接

```text
https://raw.githubusercontent.com/NICSY0572/WeatherCN-Pro/main/WeatherCN.plugin
```

## iPhone 安装步骤

1. 复制插件 Raw 链接：

```text
https://raw.githubusercontent.com/NICSY0572/WeatherCN-Pro/main/WeatherCN.plugin
```

2. 打开 iPhone 上的 Loon，进入插件页面，添加插件。

3. 开启 MITM。

4. 按 Loon 提示安装并信任 MITM 证书。

5. 确认 `weather-data.apple.com` 已开启解密。插件 MITM 主机包含：

```text
weather-data.apple.com
weatherkit.apple.com
weather-map.apple.com
```

6. 打开 Apple 天气测试。

## QWeather Key

QWeather Key 是可选项，默认留空：

```text
QWEATHER_KEY=
DEBUG=0
```

不填写也能运行。Key 为空时脚本会自动跳过 QWeather，不报错，并尝试备用数据源或缓存。

## 失败回退

WeatherCN Pro v1.2 的稳定策略：

- 第三方数据源全部失败时，自动保留 Apple 原天气响应。
- 单个模块补丁失败时，只跳过该模块，不影响其他模块。
- 缓存读取失败不会影响主流程。
- 网络失败时优先使用未过期缓存。
- 脚本总耗时控制在 4 秒以内。

缓存 TTL：

- Current：5 分钟
- AQI：10 分钟
- Hourly/Daily：30 分钟
- Alerts：2 分钟
