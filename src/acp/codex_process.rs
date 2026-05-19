#![allow(dead_code)]

use crate::acp::process::AcpEvent;
use tokio::sync::mpsc;

#[allow(dead_code)]
enum Cmd {
    Prompt(String),
    Cancel,
    Stop,
}

pub struct CodexProcess {
    #[allow(dead_code)]
    cmd_tx: mpsc::Sender<Cmd>,
    pub event_rx: mpsc::Receiver<AcpEvent>,
}

impl CodexProcess {
    pub async fn spawn(
        _codex_path: &str,
        _work_dir: &str,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        Err("CodexProcess::spawn not yet implemented".into())
    }

    #[allow(dead_code)]
    pub async fn send_prompt(&mut self, _text: &str) -> Result<(), std::io::Error> {
        Err(std::io::Error::new(std::io::ErrorKind::Other, "not yet implemented"))
    }

    #[allow(dead_code)]
    pub async fn kill(&mut self) {}
}

impl Drop for CodexProcess {
    fn drop(&mut self) {}
}
