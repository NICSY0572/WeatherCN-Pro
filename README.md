# WeatherCN Pro

中国版 iPhone 天气增强插件，适用于 Loon。

## 当前版本

v1.0.0 稳定框架版。

本版本已完成：

- WeatherKit 响应拦截
- `weatherkit.apple.com` 与 `weather-data.apple.com` MITM 配置
- 响应 JSON 安全解析
- 错误时原样返回，避免天气 App 异常
- 调试日志输出
- 后续接入下一小时降水、AQI、天气预警的扩展入口

## Loon 订阅地址

```text
https://raw.githubusercontent.com/NICSY0572/WeatherCN-Pro/main/WeatherCN.plugin
```

## 测试方式

在 Loon 日志中看到以下内容，即表示脚本已经成功接管 Apple 天气响应：

```text
[WeatherCN Pro] inject success
```

## 文件说明

```text
WeatherCN.plugin      Loon 插件订阅入口
weathercn-pro.js      主脚本
README.md             项目说明
icon.png              插件图标
```

## 重要说明

v1.0.0 不伪造天气数据，只做稳定拦截与安全注入。下一小时降水、AQI、天气预警会在确认 WeatherKit 响应结构后继续接入真实数据源。
