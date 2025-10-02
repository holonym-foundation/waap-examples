import { toast, ToastOptions } from 'react-toastify'

// USAGE:
//  const notify = useToast();
//  notify('error', 'Wallet not connected!');
//  notify('info', 'Airdrop requested:');
//  notify('warn', 'Airdrop requested:');
//  notify('success', 'Airdrop successful!',);
//  notify('error', `Airdrop failed! ${error?.message}`);
//  notify.promise(myPromise, {pending: 'Loading...', success: 'Success!', error: 'Error!'});

type ToastType = 'default' | 'success' | 'info' | 'warn' | 'error'

export const useToast = () => {
  const showToast = (type: ToastType, message: string, options?: ToastOptions) => {
    // const position = toast. // adjust according to your needs
    const position = 'top-right'

    switch (type) {
      case 'success':
        toast.success(message, {
          position,
          ...options
        })

        break

      case 'info':
        toast.info(message, {
          position,
          ...options
        })

        break

      case 'warn':
        toast.warn(message, {
          position,
          ...options
        })

        break

      case 'error':
        toast.error(message, {
          position,
          ...options
        })

        break

      default:
        toast(message, {
          position,
          ...options
        })

        break
    }
  }

  // Add promise support
  showToast.promise = <T>(
    promise: Promise<T>,
    messages: {
      pending: string;
      success: string;
      error: string | { render: (data: { data: any }) => string };
    },
    options?: ToastOptions
  ) => {
    const position = 'top-right'
    
    // Create a loading toast
    const toastId = toast.loading(messages.pending, {
      position,
      ...options
    });
    
    // Handle the promise resolution
    promise
      .then((data) => {
        // Update with success message
        toast.update(toastId, {
          render: messages.success,
          type: 'success',
          isLoading: false,
          autoClose: 1500,
          ...options
        });
        return data;
      })
      .catch((error) => {
        // For errors, we'll dismiss this toast and create a new error toast
        // to avoid the generic "Error occurred" message
        toast.dismiss(toastId);
        
        // Create a custom error message that includes the actual error
        const errorMessage = typeof messages.error === 'string' 
          ? `${messages.error}: ${error?.message || 'Unknown error'}`
          : messages.error.render({ data: error });
        
        // Show the detailed error message
        toast.error(errorMessage, {
          position,
          ...options
        });
        
        throw error;
      });
    
    return promise;
  }

  return showToast
}
