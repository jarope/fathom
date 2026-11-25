# Fathom shell integration (zsh): your .zshrc, then the command marks.
ZDOTDIR=$FATHOM_USER_ZDOTDIR
[[ -f $ZDOTDIR/.zshrc ]] && . $ZDOTDIR/.zshrc
# From here on zsh reads your own files again (.zlogin, `exec zsh`, …).
unset FATHOM_ZDOTDIR

# OSC 133 marks (the FinalTerm convention, as in iTerm, VS Code, WezTerm):
#   A prompt starts · B you type here · C the command's output starts · D;n done, exit n
# Fathom's terminal panel turns them into command blocks.
__fathom_osc() { builtin printf '\e]133;%s\a' "$1" }
__fathom_status() { __fathom_s=$? }
__fathom_precmd() {
  [[ -n $__fathom_ran ]] && __fathom_osc "D;$__fathom_s"
  __fathom_ran=
  __fathom_osc A
  # Prompt themes rebuild PS1 in their own hooks, so stay last and re-add B.
  [[ $PS1 == *'133;B'* ]] || PS1="$PS1"$'%{\e]133;B\a%}'
  precmd_functions=(__fathom_status ${precmd_functions:#__fathom_(status|precmd)} __fathom_precmd)
}
__fathom_preexec() { __fathom_ran=1; __fathom_osc C }
autoload -Uz add-zsh-hook
add-zsh-hook precmd __fathom_precmd
add-zsh-hook preexec __fathom_preexec
precmd_functions=(__fathom_status ${precmd_functions:#__fathom_status})

# Following Fathom's panes: Fathom writes the folder to $FATHOM_CD_FILE and
# sends a private key sequence; this widget changes folder and redraws the
# prompt in place — nothing is typed, so no command (or block) appears, and
# anything half-typed at the prompt stays put.
__fathom_cd() {
  local d
  d=$(<$FATHOM_CD_FILE) 2>/dev/null || return 0
  [[ -d $d ]] && builtin cd -- "$d" 2>/dev/null
  zle reset-prompt
}
if [[ -n $FATHOM_CD_FILE ]]; then
  zle -N __fathom_cd
  for __fathom_km in emacs viins vicmd; do bindkey -M $__fathom_km $'\e[57399~' __fathom_cd; done
  unset __fathom_km
fi
