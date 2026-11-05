// 启动器核心逻辑的单测：与 启动.bat 同一套判据，在 macOS 上就能跑
package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAppArgIsPureAscii(t *testing.T) {
	got := appArg(`C:\Users\Public\sms-carrier-splitter\index.html`)
	want := "file:///C:/Users/Public/sms-carrier-splitter/index.html"
	if got != want {
		t.Fatalf("ASCII 路径应当只做斜杠转换：%q != %q", got, want)
	}
	for _, r := range got {
		if r < 0x20 || r > 0x7e {
			t.Fatalf("--app 参数里出现了非 ASCII 字符（Chrome 会因此丢掉窗口）：%q", got)
		}
	}
}

func TestAppArgEncodesSpaceAndChinese(t *testing.T) {
	got := appArg(`/Users/me/下载/运营商拆表 1/app/index.html`)
	if strings.ContainsAny(got, " \u4e0b\u8f7d") {
		t.Fatalf("空格和裸中文必须编码掉：%q", got)
	}
	if !strings.HasPrefix(got, "file:///") {
		t.Fatalf("file:// 前缀被编码坏了：%q", got)
	}
	if !strings.Contains(got, "%20") {
		t.Fatalf("空格应编成 %%20：%q", got)
	}
	// 「下载」的 UTF-8 百分号编码，钉死编码方式而不是随手拼个串
	if !strings.Contains(got, "%E4%B8%8B%E8%BD%BD") {
		t.Fatalf("中文按 UTF-8 百分号编码：%q", got)
	}
	if strings.Contains(got, "%25") {
		t.Fatalf("不该二次编码（%%%% 开头说明编码了两遍）：%q", got)
	}
}

func TestBrowserArgsOrderAndNoNetwork(t *testing.T) {
	args := browserArgs(`C:\Users\Public\sms-carrier-splitter\index.html`, `C:\Users\me\AppData\Local\sms-carrier-splitter\profile`)
	if args[0] != "--app=file:///C:/Users/Public/sms-carrier-splitter/index.html" {
		t.Fatalf("第一个参数必须是 --app：%q", args)
	}
	joined := strings.Join(args, " ")
	for _, need := range []string{"--user-data-dir=", "--no-first-run", "--no-default-browser-check"} {
		if !strings.Contains(joined, need) {
			t.Fatalf("缺参数 %s：%q", need, args)
		}
	}
	if strings.Contains(joined, "http") {
		t.Fatalf("启动器不允许打开网络地址：%q", joined)
	}
}

func TestFindBrowserPrefersEnvThenCandidates(t *testing.T) {
	root := t.TempDir()
	edge := filepath.Join(root, "msedge.exe")
	chrome := filepath.Join(root, "chrome.exe")
	for _, p := range []string{edge, chrome} {
		if err := os.WriteFile(p, []byte("x"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	exists := func(p string) bool { _, err := os.Stat(p); return err == nil }

	if got := findBrowser(filepath.Join(root, "chrome.exe"), exists, []string{edge, chrome}); got != chrome {
		t.Fatalf("SMS_BROWSER 应当最优先，哪怕 Edge 也在：%q", got)
	}
	if got := findBrowser("", exists, []string{edge, chrome}); got != edge {
		t.Fatalf("没设环境变量时按候选顺序取第一个存在的（Edge 优先）：%q", got)
	}
	if got := findBrowser(filepath.Join(root, "not-here.exe"), exists, []string{edge}); got != edge {
		t.Fatalf("SMS_BROWSER 指到不存在的文件要退回候选，不能直接放弃：%q", got)
	}
	if got := findBrowser("", exists, []string{filepath.Join(root, "nope.exe")}); got != "" {
		t.Fatalf("全都找不到时返回空串交给回退分支：%q", got)
	}
}

func TestStageCopyIsByteIdenticalAndRefreshed(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "运营商拆表 1", "app", "index.html")
	if err := os.MkdirAll(filepath.Dir(src), 0o755); err != nil {
		t.Fatal(err)
	}
	want := []byte("<html>第一版</html>")
	if err := os.WriteFile(src, want, 0o644); err != nil {
		t.Fatal(err)
	}
	stage := filepath.Join(root, "Public", "sms-carrier-splitter")

	if err := stageCopy(src, stage); err != nil {
		t.Fatalf("中转目录不存在时应自建：%v", err)
	}
	got, err := os.ReadFile(filepath.Join(stage, "index.html"))
	if err != nil || string(got) != string(want) {
		t.Fatalf("复制后字节不一致：%q %v", got, err)
	}

	if err := os.WriteFile(src, []byte("<html>第二版</html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := stageCopy(src, stage); err != nil {
		t.Fatal(err)
	}
	got, _ = os.ReadFile(filepath.Join(stage, "index.html"))
	if string(got) != "<html>第二版</html>" {
		t.Fatalf("每次启动必须覆盖，否则同事拿到的是旧版网页：%q", got)
	}
}
