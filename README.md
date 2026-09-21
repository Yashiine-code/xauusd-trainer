# XAUUSD Historical Market Quiz

本地运行的 XAUUSD 历史行情交易训练 Demo。用户可以按当前周期逐根等待机会，提交 LONG / SHORT / PASS，随后按当前图表周期自动回放，并始终使用 1 分钟数据执行撮合。

## 技术栈

- React 19 + TypeScript + Vinext/Vite
- Tailwind CSS 4
- TradingView Lightweight Charts 5
- Python 3 数据清洗脚本
- Node.js 内置测试运行器

默认仍可用本地 Demo 数据运行。正式 V1 数据路径通过 `MarketDataService` 切换到 PostgreSQL，后端按 session 时钟控制数据范围；浏览器不会预先下载完整未来数据。

正式数据层、预聚合、导入与 future-data protection 的说明见 [`docs/V1_INFRASTRUCTURE.md`](docs/V1_INFRASTRUCTURE.md)。

## 快速启动

要求 Node.js `>=22.13.0` 与 Python 3。

```bash
npm install
npm run data:prepare
npm run dev
```

打开终端显示的本地地址（通常是 `http://localhost:5173`）。

运行核心交易逻辑测试：

```bash
npm test
```

生成并验证正式五周期数据与 Question Pool：

```bash
npm run data:aggregate
npm run data:validate
```

导入 PostgreSQL：

```bash
DATABASE_URL='postgresql://...' npm run db:import
MARKET_DATA_MODE=postgres DATABASE_URL='postgresql://...' npm run dev
```

生产构建：

```bash
npm run build
```

## 行情数据

默认输入文件：

```text
data/xauusd_1m.csv
```

当前已放入用户提供的 HistData XAUUSD 2026-08 数据，并生成：

```text
data/xauusd-1m.json
```

以后替换 CSV 后重新运行：

```bash
npm run data:prepare
```

也可以直接指定文件或目录：

```bash
python3 scripts/prepare_data.py /absolute/path/to/file.csv
python3 scripts/prepare_data.py /absolute/path/to/folder
```

### 支持格式 A：标准 CSV

```csv
timestamp,open,high,low,close,volume
2024-01-01 00:00:00,2062.1,2063.2,2061.8,2062.9,100
```

- `timestamp` 支持 `YYYY-MM-DD HH:mm:ss` 或 `YYYY-MM-DD HH:mm`
- `volume` 可省略；缺失时按 `0` 处理
- 时间按 UTC 解析；只要整份文件使用同一时区，刷题与周期聚合逻辑不受影响

### 支持格式 B：HistData 无表头 CSV

```csv
2026.08.02,18:00,4081.935000,4081.935000,4069.685000,4073.295000,0
```

字段顺序为：

```text
date,time,open,high,low,close,volume
```

脚本会按时间排序、对重复分钟保留最后一条记录，并校验至少有 15,120 根 1 分钟 K 线，以保证 10 天历史和至少 12 小时未来数据。

## 目录结构

```text
app/                  页面入口、受控行情 API、全局主题和元数据
src/components/       主工作台与 K 线图
src/lib/candles.ts    周期聚合、Mock 行情
src/lib/data.ts       受控行情 API 客户端
src/lib/question.ts   随机题目生成
src/lib/trading.ts    校验、撮合、R、USD、保证金、MFE、MAE
src/config/trading.ts 合约大小、Lot 和 Demo 杠杆配置
src/lib/*.test.ts     核心交易逻辑测试
src/types/            TypeScript 类型
scripts/prepare_data.py
data/xauusd_1m.csv    原始 1 分钟 CSV
data/xauusd-1m.json   仅由本地 API 使用的紧凑行情
```

## 已实现

- 随机历史题目；题目前加载约 10 个交易日、题目后至少预留 12 小时数据
- 1H / 15m / 5m / 3m / 1m 同源聚合与切换
- 缩放、拖动、十字光标、OHLC 查看
- 页面和图表均隐藏真实历史日期，横轴只显示 `Day N HH:mm`
- LONG / SHORT 模式直接在图表拖动 Entry、SL、TP，PASS 自动隐藏价格线
- 唯一数字输入为 Lot Size，支持 0.01 步进与最低 0.01 限制
- 价格线标签实时显示价格、SL USD 与 TP USD
- 价格关系校验、实时 RR、风险金额、收益金额和 Required Margin
- QUESTION 中的 Next Candle 按当前周期推进 60 / 15 / 5 / 3 / 1 分钟
- REPLAY 的单步和自动播放均跟随当前 timeframe，支持 0.5x / 1x / 2x / 5x / 10x
- 统一使用 1 分钟 K 线撮合，不受当前查看周期影响
- Entry 触发、TP、SL、NOT FILLED、DATA ENDED
- 结果 R、Result USD、持仓分钟、MFE、MAE
- TradingView 风格的红绿 Position Box、Entry / SL / TP 价格线与成交、结束标记
- TP / SL 后停在退出 K 线，只有点击 Reveal Future 才展开后续 12 小时真实行情
- 下一题完整重置状态

## 金额与保证金规则

- `XAU_CONTRACT_SIZE = 100`，即 1 standard lot = 100 oz。
- LONG PnL：`(Exit - Entry) × 100 × Lots`。
- SHORT PnL：`(Entry - Exit) × 100 × Lots`。
- Notional：`Entry × 100 × Lots`。
- Required Margin：`Notional / 2000`。
- 当前固定 Demo 杠杆为 `1:2000`，仅用于训练估算，不代表实时经纪商保证金。
- 未模拟 Unlimited Leverage、HMR、新闻时段规则、Margin Call、Stop Out 或完整账户 Equity Engine。

## 撮合规则

- Entry：当前 1 分钟 K 线满足 `Low <= Entry <= High` 即成交。
- LONG：`Low <= SL` 为 -1R；`High >= TP` 为目标 RR。
- SHORT：`High >= SL` 为 -1R；`Low <= TP` 为目标 RR。
- 同一根 1 分钟 K 线同时触及 TP 与 SL：采用保守规则，判定 SL 先发生。
- Entry 未触发时持续回放，只有真实数据结束才返回 `NOT FILLED / 0R`。
- 已成交但到数据末尾仍未触发 TP/SL：`DATA ENDED`，按最后一根 Close 计算浮动 R。
- MFE / MAE 从成交 K 线开始，到交易结束 K 线为止。

## 第一版刻意未实现

登录、服务端存储、排行榜、社区、AI 分析、指标、画线工具、多个交易品种、策略回测、Tick 级路径模拟和部署均不在本 Demo 范围内。

## 建议优先验收

1. 切换五个周期时，最后可见时间应一致且不出现未来 K 线。
2. 分别提交 LONG、SHORT 与 PASS，检查自动播放、速度切换、自动停止和 Reveal Future。
3. 直接拖动 Entry / SL / TP 构造快速成交，核对价格标签、USD、图表标记与 R。
4. 替换一份新的 1 分钟 CSV，重新运行 `npm run data:prepare`，确认无需改代码即可出题。
