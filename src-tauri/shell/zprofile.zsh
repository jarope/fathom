# Fathom shell integration (zsh): your .zprofile, unchanged.
if [[ -f $FATHOM_USER_ZDOTDIR/.zprofile ]]; then
  ZDOTDIR=$FATHOM_USER_ZDOTDIR
  . $FATHOM_USER_ZDOTDIR/.zprofile
  ZDOTDIR=$FATHOM_ZDOTDIR
fi
