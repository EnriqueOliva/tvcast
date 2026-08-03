using System;
using System.Diagnostics;
using System.Text;

internal static class HiddenLauncher
{
    private const int NO_ARGUMENTS = 0;
    private const int MISSING_COMMAND_EXIT_CODE = 1;
    private const int LAUNCH_FAILURE_EXIT_CODE = 2;
    private const int EXECUTABLE_ARGUMENT_INDEX = 0;
    private const int ARGUMENT_LINE_START_INDEX = 1;
    private const int EMPTY_LENGTH = 0;
    private const int NOT_FOUND_INDEX = -1;
    private const char QUOTE_CHARACTER = '"';
    private const char SPACE_CHARACTER = ' ';

    private static int Main(string[] arguments)
    {
        if (arguments.Length == NO_ARGUMENTS)
        {
            return MISSING_COMMAND_EXIT_CODE;
        }

        string executablePath = arguments[EXECUTABLE_ARGUMENT_INDEX];
        string argumentLine = BuildArgumentLine(arguments);

        ProcessStartInfo startInformation = new ProcessStartInfo();
        startInformation.FileName = executablePath;
        startInformation.Arguments = argumentLine;
        startInformation.UseShellExecute = false;
        startInformation.CreateNoWindow = true;
        startInformation.WindowStyle = ProcessWindowStyle.Hidden;

        try
        {
            using (Process launched = Process.Start(startInformation))
            {
                launched.WaitForExit();
                return launched.ExitCode;
            }
        }
        catch (Exception)
        {
            return LAUNCH_FAILURE_EXIT_CODE;
        }
    }

    private static string BuildArgumentLine(string[] arguments)
    {
        StringBuilder builder = new StringBuilder();

        for (int index = ARGUMENT_LINE_START_INDEX; index < arguments.Length; index++)
        {
            if (builder.Length > EMPTY_LENGTH)
            {
                builder.Append(SPACE_CHARACTER);
            }

            string currentArgument = arguments[index];
            bool needsQuoting = currentArgument.IndexOf(SPACE_CHARACTER) != NOT_FOUND_INDEX;

            if (needsQuoting)
            {
                builder.Append(QUOTE_CHARACTER);
                builder.Append(currentArgument);
                builder.Append(QUOTE_CHARACTER);
            }
            else
            {
                builder.Append(currentArgument);
            }
        }

        return builder.ToString();
    }
}
