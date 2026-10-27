import os

from dotenv import find_dotenv, load_dotenv

# Change current working directory (CWD) to the root if it's within 'src'
cwd = os.getcwd()
if 'src' in cwd:
    while os.path.basename(cwd) != 'src' and os.path.dirname(cwd) != cwd:
        cwd = os.path.dirname(cwd)
    if os.path.basename(cwd) == 'src':
        os.chdir(os.path.dirname(cwd))

# Define path for data directory
DATA_DIR_PATH = os.path.join('data')

# Create data directory if it does not exist
if not os.path.exists(DATA_DIR_PATH):
    try:
        os.mkdir(DATA_DIR_PATH)
        print('Data directory created successfully.')
    except Exception as e:
        print(f'Failed to create the data directory. Error: {e}')

# create log directory if it does not exist
if not os.path.exists(os.path.join('data', 'log')):
    try:
        os.mkdir(os.path.join('data', 'log'))
    except Exception as e:
        print(f'Failed to create the log directory. Error: {e}')


# Load .env file using python-dotenv
load_dotenv(find_dotenv('.env'))
