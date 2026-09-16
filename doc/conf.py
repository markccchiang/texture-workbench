# Sphinx configuration for the Texture Workbench documentation.
# Build with `make html` in this folder (see requirements.txt).

project = "Texture Workbench"
author = "Cheng-Chin Chiang"
copyright = "2026, Cheng-Chin Chiang"

extensions = [
    "sphinx.ext.mathjax",
]

# .venv is the virtual environment from the README; its packages ship .rst files Sphinx must not read
exclude_patterns = ["_build", ".venv", "Thumbs.db", ".DS_Store"]

html_theme = "sphinx_rtd_theme"
html_theme_options = {
    "navigation_depth": 3,
    # The wordmark carries the name, so the theme does not repeat it
    "logo_only": True,
}
# The application's mark and wordmark (web/public/, copied here so Sphinx can read them)
html_static_path = ["_static"]
html_logo = "_static/logo-name-dark.svg"
html_favicon = "_static/favicon.svg"
