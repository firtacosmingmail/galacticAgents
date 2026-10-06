#!/usr/bin/env bash
# A scripted terminal "agent" for the PTY adapter's tests (P8-08): no network, no model.
# It shows the prompt "fixture> ", reads its first line (the task) and picks a scenario from
# "scenario:<name>" in it; afterwards, at the same prompt, it echoes every line it is given
# ("echo: <line>"). Ctrl-C ends whatever it is doing and shows the prompt again; Ctrl-D at the
# prompt (end of file) exits 0.
#
#   happy       some coloured output, then exit 0
#   asks        "Which colour should the button be? " — reads the answer, then exit 0
#   permission  "Delete the build folder? [y/N] " — "deleted build" on y, else "kept build"; exit 0
#   long        30 steps of 0.1 s, then exit 0
#   echo        "ready", then the prompt
#   stalls      "working", 1 s of silence, "done", exit 0
#   movesOn     "Which one? ", then carries on without an answer; exit 0
#   env         its agent marker, process group and PTY_TEST_SECRET; exit 0
#   fails       exit 3
#   aider       "Add notes.md to the chat? (Y)es/(N)o [Yes]: " — "answer=<line>", then the prompt
#   size        "task bytes: <n> ends: <last 12 characters>", then the prompt
#
# A line "Read your instructions from <path>" (a long message, P8-08 review) is replaced by the
# file's contents, first line or later; `--prompt-file <path>` gives the task from a file
# (`{promptFile}`) instead of reading it from the terminal. At the prompt, a line from a file is
# echoed as "file echo: <bytes> bytes, ends: <last 12 characters>".
# Run alone: bash fake-pty-agent.sh (bash: `read -t`; a trapped Ctrl-C does not end a plain read)

interrupted=0
trap 'interrupted=1' INT

prompt() {
  printf 'fixture> '
}

# Reads a line into the variable $1. 0: read; 1: end of file; 130: Ctrl-C. Polls once a second:
# bash restarts a plain `read` after a trapped signal, a timed one returns.
read_line() {
  while :; do
    if IFS= read -r -t 1 "$1"; then return 0; fi
    st=$?
    [ "$interrupted" = 1 ] && return 130
    [ "$st" -le 128 ] && return 1
  done
}

repl() {
  while :; do
    interrupted=0
    prompt
    read_line line
    case $? in
      0)
        case "$line" in
          'Read your instructions from '*)
            body=$(cat "${line#Read your instructions from }")
            printf 'file echo: %s bytes, ends: %s\n' "${#body}" "${body: -12}"
            ;;
          *) [ -n "$line" ] && printf 'echo: %s\n' "$line" ;;
        esac
        ;;
      130) printf '\n' ;;
      *) exit 0 ;;
    esac
  done
}

printf '\033[1mfake pty agent\033[0m 1.0\n'
if [ "$1" = --prompt-file ]; then
  task=$(cat "$2")
  printf 'task from %s\n' "$2"
else
  prompt
  read_line task || exit 0
fi
case "$task" in
  'Read your instructions from '*)
    file=${task#Read your instructions from }
    task=$(cat "$file")
    printf 'instructions read from a file\n'
    ;;
esac
case "$task" in
  *scenario:happy*)
    printf '\033[32mreading\033[0m the README\n'
    printf 'writing \033[33mnotes.md\033[0m\n'
    printf 'all done\n'
    exit 0
    ;;
  *scenario:asks*)
    printf 'Which colour should the button be? '
    if read_line answer; then
      printf 'you chose: %s\n' "$answer"
      exit 0
    fi
    printf '\n'
    repl
    ;;
  *scenario:permission*)
    printf 'about to clean up\n'
    printf 'Delete the build folder? [y/N] '
    if read_line answer; then
      case "$answer" in
        y|Y|yes) printf 'deleted build\n' ;;
        *) printf 'kept build\n' ;;
      esac
      exit 0
    fi
    printf '\n'
    repl
    ;;
  *scenario:long*)
    i=1
    while [ "$i" -le 30 ]; do
      [ "$interrupted" = 1 ] && break
      printf 'step %s of 30\n' "$i"
      sleep 0.1
      i=$((i + 1))
    done
    if [ "$interrupted" = 1 ]; then
      printf '\ninterrupted\n'
      repl
    fi
    printf 'long job done\n'
    exit 0
    ;;
  *scenario:echo*)
    printf 'ready\n'
    repl
    ;;
  *scenario:stalls*)
    printf 'working\n'
    sleep 1
    printf 'done\n'
    exit 0
    ;;
  *scenario:movesOn*)
    printf 'Which one? '
    sleep 0.6
    printf '\nnever mind, carrying on\n'
    sleep 0.4
    printf 'finished on my own\n'
    exit 0
    ;;
  *scenario:env*)
    printf 'agent=%s pgid=%s secret=%s\n' "$GALACTIC_AGENT_ID" "$(ps -o pgid= -p $$ | tr -d ' ')" "${PTY_TEST_SECRET:-none}"
    exit 0
    ;;
  *scenario:aider*)
    printf 'Add notes.md to the chat? (Y)es/(N)o [Yes]: '
    if read_line answer; then
      printf 'answer=%s\n' "$answer"
    else
      printf '\n'
    fi
    repl
    ;;
  *scenario:size*)
    printf 'task bytes: %s ends: %s\n' "${#task}" "${task: -12}"
    repl
    ;;
  *scenario:fails*)
    printf 'something broke\n'
    exit 3
    ;;
  *)
    printf 'unknown task: %s\n' "$task"
    repl
    ;;
esac
