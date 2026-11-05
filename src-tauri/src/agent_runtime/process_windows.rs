//! A suspended spawn joins a kill-on-close Job before any agent code can fork.
use std::{
    io,
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
};
use tokio::process::{Child, Command};
use windows_sys::Win32::{
    Foundation::{HANDLE, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
            JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
            TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{
            OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
        },
    },
};

#[derive(Clone)]
pub(crate) struct ProcessGroup(Option<std::sync::Arc<OwnedHandle>>);

impl ProcessGroup {
    pub(crate) fn kill(&mut self) -> bool {
        let Some(job) = self.0.as_ref() else {
            return true;
        };
        // SAFETY: the owned handle is a Job created by this module.
        if unsafe { TerminateJobObject(job.as_raw_handle(), 1) } == 0 {
            return false;
        }
        // Termination is asynchronous. Do not activate a replacement installation
        // until every process in this Job has released its executable files.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        loop {
            let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            // SAFETY: info is initialized and the buffer size matches its type.
            if unsafe {
                QueryInformationJobObject(
                    job.as_raw_handle(),
                    JobObjectBasicAccountingInformation,
                    (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return false;
            }
            if info.ActiveProcesses == 0 {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }

    pub(crate) fn disarm(&mut self) {
        // Closing also terminates leftover descendants after a successful parent exit.
        self.0 = None;
    }
}

fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        // SAFETY: caller passes a newly created, uniquely owned kernel handle.
        Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
    }
}

pub(crate) fn spawn(command: &mut Command) -> io::Result<(Child, ProcessGroup)> {
    // SAFETY: null security/name pointers request an unnamed, non-inheritable Job.
    let job = owned(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) })?;
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: limits is initialized and its exact size is supplied.
    if unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    command
        .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW)
        .kill_on_drop(true);
    let mut child = command.spawn()?;
    let result = (|| {
        let process = child
            .raw_handle()
            .ok_or_else(|| io::Error::other("Missing process handle"))?;
        // SAFETY: both handles are valid and remain owned for the duration of the call.
        if unsafe { AssignProcessToJobObject(job.as_raw_handle(), process as HANDLE) } == 0 {
            return Err(io::Error::last_os_error());
        }
        resume(
            child
                .id()
                .ok_or_else(|| io::Error::other("Missing process id"))?,
        )
    })();
    if let Err(error) = result {
        let _ = child.start_kill();
        return Err(error);
    }
    Ok((child, ProcessGroup(Some(std::sync::Arc::new(job)))))
}

fn resume(pid: u32) -> io::Result<()> {
    // SAFETY: snapshot returns a new owned handle; entry has the required size.
    let snapshot = owned(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) })?;
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
    while found != 0 {
        if entry.th32OwnerProcessID == pid {
            // The process is suspended before its first instruction, so this is
            // its sole initial thread and cannot disappear or spawn more threads.
            let thread =
                owned(unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) })?;
            if unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            return Ok(());
        }
        found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
    }
    Err(io::Error::other("Suspended process thread not found"))
}
