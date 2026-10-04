const cleanupMs = Number(process.argv[2]);
const keepAlive = setInterval(() => {}, 60_000);
let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  console.log("CLEANUP_STARTED");
  if (cleanupMs < 0) return;
  setTimeout(() => {
    clearInterval(keepAlive);
    console.log("CLEANUP_FINISHED");
    process.exit(0);
  }, cleanupMs);
});
console.log(JSON.stringify({ ready: true, pid: process.pid, executable: process.execPath }));
