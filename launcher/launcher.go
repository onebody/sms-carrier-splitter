// 启动器的可测核心：路径中转、参数拼装、浏览器挑选。
// 判据与 启动.bat 完全一致，抽成纯函数是为了在 macOS 上也能 go test；PE 行为交给 Windows 虚拟机实测。
package main

import (
	"fmt"
	"os"
	"strings"
)

// file:// URL 里允许原样出现的字符，其余一律百分号编码
func urlSafe(c byte) bool {
	switch {
	case 'a' <= c && c <= 'z', 'A' <= c && c <= 'Z', '0' <= c && c <= '9':
		return true
	}
	return strings.IndexByte("-._~:/", c) >= 0
}

// appArg 拼出 --app 要的值。Chrome/Edge 实测会整个忽略带裸中文的 file:// 路径（只弹空白标签页），
// 所以这里保证结果全是可打印 ASCII：反斜杠转正斜杠，空格与非 ASCII 按 UTF-8 百分号编码。
func appArg(p string) string {
	var b strings.Builder
	b.WriteString("file:///")
	for _, c := range []byte(strings.ReplaceAll(p, "\\", "/")) {
		if urlSafe(c) {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func browserArgs(stagePath, profileDir string) []string {
	return []string{
		"--app=" + appArg(stagePath),
		"--user-data-dir=" + profileDir,
		"--no-first-run",
		"--no-default-browser-check",
	}
}

// findBrowser：SMS_BROWSER 指到真实文件时最优先，否则按候选顺序取第一个存在的，全都没有返回空串。
func findBrowser(envBrowser string, exists func(string) bool, candidates []string) string {
	if envBrowser != "" && exists(envBrowser) {
		return envBrowser
	}
	for _, c := range candidates {
		if exists(c) {
			return c
		}
	}
	return ""
}

// stageCopy 把包内网页复制成 <stageDir>/index.html。
// 用复制而不是软链：包可能放在只读共享盘上；每次启动覆盖：同事换新版后不会留旧网页。
func stageCopy(src, stageDir string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(stageDir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(stageDir+string(os.PathSeparator)+"index.html", data, 0o644)
}
