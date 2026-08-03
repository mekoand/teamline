# Teamline

Teamline 是面向个人开发者的本地 AI 编码工作台。当前版本可以为本地 Git 仓库创建委托，并把数据保存在本机。

## 本地运行

需要 [Bun](https://bun.sh/)。项目目前没有第三方依赖。

```bash
bun run dev
```

然后打开 <http://127.0.0.1:4310>。

## 命令行入口

保持本地服务运行后，可以在准备委托的目录中使用 CLI：

```bash
bun run cli -- create "修复登录页偶发的空白" --acceptance "相关测试通过"
bun run cli -- list
bun run cli -- show <委托 ID 或唯一前缀>
bun run cli -- pause <委托 ID 或唯一前缀>
bun run cli -- continue <委托 ID 或唯一前缀>
bun run cli -- open <委托 ID 或唯一前缀>
```

安装或链接这个包后，也可以直接使用 `teamline` 命令。CLI 与网页连接同一个本地服务和 SQLite 数据；它只承担创建、查询、暂停、继续和打开网页这些日常入口。计划编辑、执行地图和资源安排仍在网页中完成。

个人版 v0 的完整范围与实现顺序见 [`docs/specs/personal-v0.md`](docs/specs/personal-v0.md)。
