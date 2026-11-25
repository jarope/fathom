# Fathom shell integration (zsh). Fathom points ZDOTDIR here so it can add
# command marks; each file loads your own one first, from your usual place.
: ${FATHOM_USER_ZDOTDIR:=$HOME}
if [[ -f $FATHOM_USER_ZDOTDIR/.zshenv ]]; then
  ZDOTDIR=$FATHOM_USER_ZDOTDIR
  . $FATHOM_USER_ZDOTDIR/.zshenv
  FATHOM_USER_ZDOTDIR=${ZDOTDIR:-$HOME}   # your .zshenv may move ZDOTDIR
fi
ZDOTDIR=$FATHOM_ZDOTDIR
