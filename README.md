# Hikvision 产品抓取与思维导图

这个项目会抓取 Hikvision 官网中英文产品页，生成：

- 结构化产品数据 `data/`
- 同系列型号差异报告 `site/data.json`
- Mermaid 思维导图 `site/mindmaps/`
- 可切换中英文的静态查看页 `site/index.html`

## 使用

1. 安装依赖

```powershell
npm install
```

2. 先跑小样本验证

```powershell
npm run update:sample
```

3. 跑完整更新

```powershell
npm run update
```

4. 本地预览

```powershell
npm run serve
```

然后打开 `http://127.0.0.1:4173`

或者直接双击运行：

```powershell
.\open-web.ps1
```

关闭本地网页服务：

```powershell
.\stop-web.ps1
```

## 发布到 GitHub Pages

这个项目已经包含 GitHub Pages 工作流：

- [deploy-pages.yml](C:\Users\Administrator\Documents\hikvision 技术栈\.github\workflows\deploy-pages.yml)

最简单的发布方式：

```powershell
.\publish-github.ps1
```

然后按脚本输出完成：

```powershell
git remote add origin <你的仓库地址>
git commit -m "Initial publish"
git push -u origin main
```

推送后去 GitHub：

1. 打开仓库 `Settings`
2. 打开 `Pages`
3. `Source` 选择 `GitHub Actions`

公开访问地址通常是：

- `https://<你的用户名>.github.io/<仓库名>/`

工作流会自动执行抓取并发布最新静态网页。

## 自动更新

可以直接运行：

```powershell
.\update-hikvision.ps1
```

它会自动执行 `npm install` 和 `npm run update`。

如果你想接入 Codex 自动化，本线程已经附带一个建议创建的自动任务。
