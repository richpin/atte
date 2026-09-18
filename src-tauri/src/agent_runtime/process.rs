//! Cleanup is restricted to a process group we created and its live descendants.
use nix::{
    sys::signal::{killpg, Signal},
    unistd::Pid,
};

pub(crate) struct ProcessGroup(pub(crate) Option<u32>);

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        if let Some(id) = self.0 {
            let pid = Pid::from_raw(id as i32);
            #[cfg(target_os = "macos")]
            kill_descendants(pid);
            let _ = killpg(pid, Signal::SIGKILL);
        }
    }
}

#[cfg(target_os = "macos")]
fn kill_descendants(root: Pid) {
    use nix::{libc, sys::signal::kill};
    let mut pending = vec![root];
    let mut stopped = Vec::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(250);
    while let Some(pid) = pending.pop() {
        if pid.as_raw() <= 1 || stopped.contains(&pid) || kill(pid, Signal::SIGSTOP).is_err() {
            continue;
        }
        stopped.push(pid);
        wait_until_stopped(pid, deadline);
        // Freeze each parent before enumeration so it cannot fork another child.
        // MCP servers and code-mode hosts can leave their ancestor's process group.
        // SAFETY: libproc accepts a null buffer for sizing; the second call receives
        // a valid initialized pid_t array and its byte size. Its return is a PID count.
        let count = unsafe { libc::proc_listchildpids(pid.as_raw(), std::ptr::null_mut(), 0) };
        if count <= 0 {
            continue;
        }
        let mut children = vec![0_i32; count as usize + 16];
        let length = unsafe {
            libc::proc_listchildpids(
                pid.as_raw(),
                children.as_mut_ptr().cast(),
                std::mem::size_of_val(children.as_slice()) as i32,
            )
        };
        pending.extend(
            children
                .into_iter()
                .take(length.max(0) as usize)
                .map(Pid::from_raw),
        );
    }
    for pid in stopped.into_iter().rev() {
        let _ = kill(pid, Signal::SIGKILL);
    }
}

#[cfg(target_os = "macos")]
fn wait_until_stopped(pid: Pid, deadline: std::time::Instant) {
    use nix::libc;
    while std::time::Instant::now() < deadline {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
        // SAFETY: the buffer is correctly aligned and sized. Only read it when
        // libproc reports that it initialized the entire struct.
        let size = std::mem::size_of_val(&info) as i32;
        let read = unsafe {
            libc::proc_pidinfo(
                pid.as_raw(),
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        };
        if read != size {
            return;
        }
        let info = unsafe { info.assume_init() };
        if matches!(info.pbi_status, libc::SSTOP | libc::SZOMB) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    // An unresponsive process must not make Drop hang; retain group termination
    // and the descendant snapshot as the bounded fallback.
}
