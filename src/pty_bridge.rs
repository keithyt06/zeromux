use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use tokio::sync::mpsc;

pub struct PtyHandle {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

impl PtyHandle {
    pub fn spawn(
        cmd: &str,
        args: &[&str],
        env: &[(&str, &str)],
        cols: u16,
        rows: u16,
        cwd: Option<&str>,
    ) -> Result<(Self, mpsc::Receiver<Vec<u8>>), Box<dyn std::error::Error + Send + Sync>> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut cmd_builder = CommandBuilder::new(cmd);
        cmd_builder.args(args);
        cmd_builder.env("TERM", "xterm-256color");
        cmd_builder.env("COLORTERM", "truecolor");
        // A zeromux started from inside tmux would otherwise make every
        // `tmux attach/new-session` refuse with "sessions should be nested".
        cmd_builder.env_remove("TMUX");
        for (k, v) in env {
            cmd_builder.env(k, v);
        }
        if let Some(dir) = cwd {
            cmd_builder.cwd(dir);
        }

        let child = pair.slave.spawn_command(cmd_builder)?;
        // Drop the slave side - we only need the master
        drop(pair.slave);

        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        let (tx, rx) = mpsc::channel::<Vec<u8>>(256);

        // Spawn blocking reader thread
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.blocking_send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok((
            PtyHandle {
                writer,
                master: pair.master,
                child,
            },
            rx,
        ))
    }

    pub fn write_input(&mut self, data: &[u8]) -> Result<(), std::io::Error> {
        self.writer.write_all(data)?;
        self.writer.flush()
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    /// Get the child process PID
    pub fn pid(&self) -> Option<u32> {
        self.child.process_id()
    }
}
