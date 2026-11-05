//go:build windows

// Windows 侧接线：定位包目录、中转网页、拉起 Edge/Chrome。
// 编译成 GUI 子系统（-H=windowsgui），双击不闪控制台；出错弹对话框，同事才看得见。
package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

var (
	user32        = syscall.NewLazyDLL("user32.dll")
	shell32       = syscall.NewLazyDLL("shell32.dll")
	procMsgBox    = user32.NewProc("MessageBoxW")
	procShellExec = shell32.NewProc("ShellExecuteW")
)

func alert(title, body string) {
	t, _ := syscall.UTF16PtrFromString(title)
	b, _ := syscall.UTF16PtrFromString(body)
	procMsgBox.Call(uintptr(0), uintptr(unsafe.Pointer(b)), uintptr(unsafe.Pointer(t)), 0x30) // MB_ICONWARNING
}

// openWithDefaultBrowser 走 ShellExecuteW：受限目录里 exec cmd 会闪一个黑框
func openWithDefaultBrowser(path string) {
	p, _ := syscall.UTF16PtrFromString(path)
	procShellExec.Call(uintptr(0), 0, uintptr(unsafe.Pointer(p)), 0, 0, 1) // 0=NULL(默认动作 open)，1=SW_SHOWNORMAL
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// browserCandidates 与 启动.bat 的探测顺序一致：Edge 优先（Win10/11 自带）
func browserCandidates() []string {
	var out []string
	for _, key := range []string{"ProgramFiles(x86)", "ProgramFiles", "LocalAppData"} {
		root := os.Getenv(key)
		if root == "" {
			continue
		}
		out = append(out,
			filepath.Join(root, `Microsoft\Edge\Application\msedge.exe`),
			filepath.Join(root, `Google\Chrome\Application\chrome.exe`))
	}
	return out
}

func main() {
	exe, err := os.Executable()
	if err != nil {
		alert("运营商拆表 打不开", "拿不到自身路径，请用整个文件夹里的 启动.bat 打开。")
		return
	}
	src := filepath.Join(filepath.Dir(exe), "app", "index.html")
	if !fileExists(src) {
		alert("运营商拆表 打不开", "找不到 app\\index.html。\n请把整个「运营商拆表」文件夹一起拷贝，不要只拷这个 exe。")
		return
	}

	// 网页先落到一条恒定 ASCII 路径：Chrome/Edge 遇到路径里的裸中文会丢掉 --app 窗口
	stageDir := filepath.Join(os.Getenv("PUBLIC"), "sms-carrier-splitter")
	if os.Getenv("PUBLIC") == "" {
		stageDir = filepath.Join(os.Getenv("LocalAppData"), "sms-carrier-splitter", "stage")
	}
	if err = stageCopy(src, stageDir); err != nil {
		openWithDefaultBrowser(src)
		alert("已用默认浏览器打开", "无法写入中转目录（受限账户或只读盘），\n页面已在普通标签页里打开，功能完全一样。")
		return
	}

	browser := findBrowser(os.Getenv("SMS_BROWSER"), fileExists, browserCandidates())
	if browser == "" {
		openWithDefaultBrowser(src)
		alert("没找到 Edge 或 Chrome", "已用默认浏览器打开（普通标签页）。\n便携版浏览器可设环境变量 SMS_BROWSER 指向 exe 后再启动。")
		return
	}

	profile := filepath.Join(os.Getenv("LocalAppData"), "sms-carrier-splitter", "profile")
	stage := filepath.Join(stageDir, "index.html")
	if err = exec.Command(browser, browserArgs(stage, profile)...).Start(); err != nil {
		openWithDefaultBrowser(src)
		alert("浏览器启动失败", "已改用默认浏览器打开。\n"+err.Error())
	}
}
