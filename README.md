# 运营商拆表 · 手机号按运营商分类 / 拆表 / 下单清单

给一份含手机号的 Excel / CSV，在**本机浏览器里**完成：按运营商分类并加一列标注、按三大或四大运营商拆成不同 sheet、生成给运营商的下单清单。同时支持去重（只留首次行 + 单列「重复号码」）和从整句文本中提取号码（一格多号拆成多行）。

三条承诺：

- **不联网**：整个页面是单文件 HTML，引擎（SheetJS + 号段表）全部内联，测试断言「零非 `file://` 请求」。断网机、内网机照常用。
- **不改你的源文件**：只读取，结果一律另存为新文件，原有列与列序保持不动。
- **可核对**：发布包里每个文件的 SHA256 都写在 `版本与校验.txt`，双击 `校验文件完整性.bat` 逐条比对。

## 拿来就用

到 [Releases](../../releases) 下 `sms-carrier-splitter-v1.1.0.zip`，解压后整个文件夹拷给同事（附件名必须是英文，GitHub 会把中文名剥掉；解压出来的文件夹和里面的文件仍是中文名的 `运营商拆表`）：

| 系统 | 怎么打开 |
| --- | --- |
| Windows | 双击 `运营商拆表.exe`（无边框独立窗口）；被安全策略拦了就双击 `启动.bat`，效果一致 |
| macOS | 双击 `Mac版-运营商拆表.app`；首次提示「无法验证开发者」时右键 → 打开 |
| 任意 | 直接把 `app/index.html` 拖进 Chrome/Edge |

第一次从微信/网盘下载后 Windows 可能弹蓝色 SmartScreen：点「更多信息」→「仍要运行」。exe 和 bat 都没有代码签名（签名要买证书并绑定发布者主体），属正常提示。

## 目录结构

```
src/                 index.html 模板 + app.js（页面主流程）+ segment.js（号段表与匹配）
vendor/              xlsx.full.min.js（SheetJS 0.20.3，社区版，Apache-2.0，文件头许可保留）
build.py             把 src 内联成根目录的单文件网页 号码运营商分类与拆表.html
package.py           生成分发文件夹与 zip；有 go + rsrc 时交叉编译 Windows exe，缺了就用 启动.bat 兜底
launcher/            Windows 启动器（Go，纯标准库，GOOS=windows -H=windowsgui，图标烘进文件）
test/                单元 / 端到端 / 产物回读 / 可视化报告 / 包内实跑 / Windows 真机
fixtures/            测试夹具（示例表由 test/make_sample.py 生成，姓名与号码都是编造的，不含真实客户数据）
```

`dist/`、根目录的单文件 html、`fixtures/out|report` 是构建与测试产物，已 gitignore，发布时作为 Release 附件。

## 构建

```bash
python3 build.py                      # src → 单文件 html（约 989 KB）
python3 package.py                    # → dist/运营商拆表/ + dist/运营商拆表-v1.1.0.zip
```

要出 Windows exe 需要 `go` 和 `rsrc`（`go install github.com/akavel/rsrc@latest`）；缺失时 `package.py` 会跳过 exe 并打印提示，包里的 `启动.bat` 功能相同。

## 测试

```bash
node --test test/segment.test.js test/package.test.js   # 号段匹配 + 包结构断言
node test/e2e.mjs                                       # CDP 驱动 headless Chrome，跑完整业务并导出产物字节
python3 test/verify_output.py                           # 用 openpyxl（与页面不同实现）独立回读产物
node test/visual_run.mjs                                # 18 步带界面跑测，产出 fixtures/report/测试报告.html
node test/package_app_check.mjs                         # 直接跑发布包里的 Mac 启动器
```

Windows 真机验证（在 Parallels 客户机里跑，需要真 Edge）：

```bash
# 业务链路 + 真下载目录：python windows_vm_check.py <包目录> <工作目录>
test/windows_vm_check.py
# 「双击 启动.bat」现场取证（中转文件哈希一致、窗口标题、profile 目录）
powershell -File test/windows_vm_bat_check.ps1 -Pkg C:\pkg-test\运营商拆表
```

最近一次实测环境：Windows 11 ARM64（build 22621）+ 本机 Edge，`windows_vm_check.py` 13/13 通过，导出的拆分表（8 张 sheet）与下单清单真实落在系统下载目录，0 条外部请求、0 条 JS 未捕获异常；Windows 产物与 macOS 产物用 openpyxl 逐格对账一致（仅「汇总」里的源文件名不同）。

## 已知限制

- 归属按工信部号段核发公告判断，**携号转网后的号码仍按原号段归类**，与该机当前实际服务商可能不一致；批量下单前建议向运营商索取携转名单。
- 144/148/145 等物联网、上网卡号段，165/167/170x 等虚商转售号段会在备注列写明。号段表版本见页脚（当前 2026-11），新号段核发后需要更新 `src/segment.js`。
- 一次只读一个 sheet 的一个号码列；`.xls` / `.ods` 由内置引擎解析，公式类工作簿只取已算出的值。
- 打开用的是本机已有的 Edge/Chrome，不额外安装任何东西。

## 许可

第三方：SheetJS 社区版（`vendor/xlsx.full.min.js`，Apache-2.0，原始文件头保留）。本仓库当前是内部工具发布，未额外声明开源许可证；需要改成 MIT 之类的请自行提 PR 前先确认。
